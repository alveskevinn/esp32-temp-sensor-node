// Integration tests for PostgresStore. Runs only when TEST_DATABASE_URL is set
// (CI provides a Postgres service container):
//   TEST_DATABASE_URL=postgres://iot:iot@localhost:5432/iot npm test
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresStore } from '../src/store/postgres.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PostgresStore', () => {
  let store: PostgresStore;

  beforeAll(async () => {
    store = await PostgresStore.connect(url!);
  });

  beforeEach(async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('TRUNCATE readings, devices');
    await client.end();
  });

  afterAll(async () => {
    await store?.close();
  });

  it('upserts heartbeats without clobbering known fields', async () => {
    await store.upsertHeartbeat({ deviceId: 'n1', model: 'temp-node', fw: 3, batteryMv: 4000, seenAt: new Date() });
    const d = await store.upsertHeartbeat({ deviceId: 'n1', batteryMv: 3900, seenAt: new Date() });
    expect(d).toMatchObject({ id: 'n1', model: 'temp-node', fw: 3, batteryMv: 3900, intervalS: 300, alertMax: 8 });
  });

  it('inserts readings idempotently and exposes the latest one', async () => {
    await store.upsertHeartbeat({ deviceId: 'n1', seenAt: new Date() });
    const readings = [
      { ts: new Date('2026-11-03T10:00:00Z'), t: 4.5 },
      { ts: new Date('2026-11-03T10:05:00Z'), t: 4.75 },
    ];
    expect(await store.insertReadings('n1', readings)).toBe(2);
    expect(await store.insertReadings('n1', readings)).toBe(0);

    const d = await store.getDevice('n1');
    expect(d?.lastTemp).toBeCloseTo(4.75);
    expect(d?.lastReadingAt?.toISOString()).toBe('2026-11-03T10:05:00.000Z');
  });

  it('returns the latest N readings oldest first within a range', async () => {
    await store.upsertHeartbeat({ deviceId: 'n1', seenAt: new Date() });
    const base = Date.parse('2026-11-03T10:00:00Z');
    await store.insertReadings(
      'n1',
      Array.from({ length: 10 }, (_, i) => ({ ts: new Date(base + i * 60_000), t: i })),
    );
    const last3 = await store.getReadings('n1', { limit: 3 });
    expect(last3.map((r) => r.t)).toEqual([7, 8, 9]);
    const ranged = await store.getReadings('n1', { from: new Date(base + 2 * 60_000), to: new Date(base + 4 * 60_000), limit: 100 });
    expect(ranged.map((r) => r.t)).toEqual([2, 3, 4]);
  });

  it('updates settings', async () => {
    await store.upsertHeartbeat({ deviceId: 'n1', seenAt: new Date() });
    const d = await store.updateDevice('n1', { name: 'Fridge', intervalS: 120, alertMin: 1 });
    expect(d).toMatchObject({ name: 'Fridge', intervalS: 120, alertMin: 1, batch: 6 });
    expect(await store.updateDevice('ghost', { batch: 2 })).toBeNull();
  });
});
