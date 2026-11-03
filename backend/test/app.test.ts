import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';

const INGEST = 'Bearer test-ingest';
const ADMIN = 'Bearer test-admin';
const NOW = new Date('2026-11-03T12:00:00Z');
const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

let app: Awaited<ReturnType<typeof buildApp>>;
let clock: Date;

async function makeApp(firmwareDir?: string) {
  clock = NOW;
  app = await buildApp({
    store: new MemoryStore(),
    ingestToken: 'test-ingest',
    adminToken: 'test-admin',
    firmwareDir,
    now: () => clock,
  });
}

const ingest = (body: object, auth = INGEST) =>
  app.inject({ method: 'POST', url: '/api/v1/readings', headers: { authorization: auth }, payload: body });

beforeEach(() => makeApp());
afterEach(() => app.close());

describe('POST /api/v1/readings', () => {
  it('rejects requests without the ingest token', async () => {
    const res = await ingest({ device_id: 'n1', readings: [] }, 'Bearer nope');
    expect(res.statusCode).toBe(401);
  });

  it('validates the payload', async () => {
    const res = await ingest({ device_id: 'bad id!', readings: [] });
    expect(res.statusCode).toBe(400);
  });

  it('stores a batch and returns the remote config', async () => {
    const res = await ingest({
      device_id: 'fridge-01',
      model: 'temp-node',
      fw: 3,
      battery_mv: 3950,
      battery_pct: 76,
      readings: [
        { ts: epoch('2026-11-03T11:50:00Z'), t: 4.5 },
        { ts: epoch('2026-11-03T11:55:00Z'), t: 4.75 },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ accepted: 2, inserted: 2, interval_s: 300, batch: 6 });

    const device = (await app.inject('/api/v1/devices/fridge-01')).json();
    expect(device).toMatchObject({ battery_pct: 76, last_temp: 4.75, status: 'ok', fw: 3 });
  });

  it('is idempotent when a node retries the same batch', async () => {
    const batch = { device_id: 'n1', readings: [{ ts: epoch('2026-11-03T11:00:00Z'), t: 5 }] };
    await ingest(batch);
    const retry = await ingest(batch);
    expect(retry.json()).toMatchObject({ accepted: 1, inserted: 0 });
    const rows = (await app.inject('/api/v1/devices/n1/readings')).json();
    expect(rows).toHaveLength(1);
  });

  it('places readings from an unsynced clock using age_s', async () => {
    await ingest({ device_id: 'n1', readings: [{ age_s: 600, t: 5 }] });
    const rows = (await app.inject('/api/v1/devices/n1/readings')).json();
    expect(rows[0].ts).toBe('2026-11-03T11:50:00.000Z');
  });

  it('drops readings dated in the future', async () => {
    const res = await ingest({ device_id: 'n1', readings: [{ ts: epoch('2030-01-01T00:00:00Z'), t: 5 }] });
    expect(res.json()).toMatchObject({ accepted: 0 });
  });

  it('offers OTA when the manifest has a version for the model', async () => {
    await app.close();
    const dir = await mkdtemp(join(tmpdir(), 'fw-'));
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ 'temp-node': 4 }));
    await writeFile(join(dir, 'temp-node.bin'), Buffer.from([0xe9, 0x01, 0x02]));
    await makeApp(dir);

    const res = await ingest({ device_id: 'n1', model: 'temp-node', fw: 3, readings: [] });
    expect(res.json().fw_version).toBe(4);

    const bin = await app.inject({ url: '/api/v1/firmware/temp-node', headers: { authorization: INGEST } });
    expect(bin.statusCode).toBe(200);
    expect(bin.rawPayload).toEqual(Buffer.from([0xe9, 0x01, 0x02]));
    expect((await app.inject('/api/v1/firmware/temp-node')).statusCode).toBe(401);
  });
});

describe('device status', () => {
  it('flags readings outside the alert range', async () => {
    await ingest({ device_id: 'n1', readings: [{ ts: epoch('2026-11-03T11:59:00Z'), t: 9.2 }] });
    expect((await app.inject('/api/v1/devices/n1')).json().status).toBe('alert');
  });

  it('marks a node stale after two missed uploads', async () => {
    await ingest({ device_id: 'n1', readings: [{ ts: epoch('2026-11-03T11:59:00Z'), t: 5 }] });
    clock = new Date(NOW.getTime() + 2 * 300 * 6 * 1000 + 121_000);
    expect((await app.inject('/api/v1/devices/n1')).json().status).toBe('stale');
  });
});

describe('PATCH /api/v1/devices/:id', () => {
  beforeEach(async () => {
    await ingest({ device_id: 'n1', readings: [] });
  });

  it('requires the admin token', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/devices/n1', headers: { authorization: INGEST }, payload: { batch: 3 } });
    expect(res.statusCode).toBe(401);
  });

  it('updates settings that the node receives on its next upload', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/devices/n1',
      headers: { authorization: ADMIN },
      payload: { name: 'Vaccine fridge', interval_s: 120, alert_max: 6 },
    });
    expect(res.statusCode).toBe(200);
    const next = await ingest({ device_id: 'n1', readings: [] });
    expect(next.json()).toMatchObject({ interval_s: 120, alert_max: 6 });
  });

  it('rejects an inverted alert range', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/devices/n1', headers: { authorization: ADMIN }, payload: { alert_min: 9 } });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v1/devices/:id/readings', () => {
  it('returns the latest N readings oldest first', async () => {
    const readings = Array.from({ length: 10 }, (_, i) => ({ ts: epoch('2026-11-03T10:00:00Z') + i * 60, t: i }));
    await ingest({ device_id: 'n1', readings });
    const rows = (await app.inject('/api/v1/devices/n1/readings?limit=3')).json();
    expect(rows.map((r: { t: number }) => r.t)).toEqual([7, 8, 9]);
  });

  it('404s for unknown devices', async () => {
    expect((await app.inject('/api/v1/devices/ghost/readings')).statusCode).toBe(404);
  });
});
