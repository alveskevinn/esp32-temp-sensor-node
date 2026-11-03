import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Device, Reading, Store } from './store/types.js';

export interface AppOptions {
  store: Store;
  /** Bearer token the nodes send to /readings and /firmware. */
  ingestToken: string;
  /** Bearer token for PATCH /devices/:id. Reads are public (put a proxy in front for auth). */
  adminToken: string;
  /** Directory with `<model>.bin` files and a `manifest.json` ({ "<model>": <version> }). */
  firmwareDir?: string;
  logger?: boolean;
  now?: () => Date;
}

type DeviceStatus = 'ok' | 'alert' | 'stale' | 'unknown';

export function deviceStatus(d: Device, now: Date): DeviceStatus {
  if (!d.lastSeen) return 'unknown';
  // A node uploads once per batch; allow two missed uploads plus slack.
  const expectedGapMs = d.intervalS * d.batch * 1000;
  if (now.getTime() - d.lastSeen.getTime() > expectedGapMs * 2 + 120_000) return 'stale';
  if (d.lastTemp !== null && (d.lastTemp < d.alertMin || d.lastTemp > d.alertMax)) return 'alert';
  return 'ok';
}

const toDto = (d: Device, now: Date) => ({
  id: d.id,
  name: d.name,
  model: d.model,
  fw: d.fw,
  battery_mv: d.batteryMv,
  battery_pct: d.batteryPct,
  rssi: d.rssi,
  interval_s: d.intervalS,
  batch: d.batch,
  alert_min: d.alertMin,
  alert_max: d.alertMax,
  last_seen: d.lastSeen?.toISOString() ?? null,
  last_temp: d.lastTemp,
  last_reading_at: d.lastReadingAt?.toISOString() ?? null,
  status: deviceStatus(d, now),
});

const tokenMatches = (header: string | undefined, expected: string): boolean => {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
};

const requireToken = (token: string) => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!tokenMatches(req.headers.authorization, token)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
};

interface IngestBody {
  device_id: string;
  model?: string;
  fw?: number;
  battery_mv?: number;
  battery_pct?: number;
  rssi?: number;
  readings: { ts?: number; age_s?: number; t: number }[];
}

const ingestSchema = {
  body: {
    type: 'object',
    required: ['device_id', 'readings'],
    properties: {
      device_id: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' },
      model: { type: 'string', maxLength: 32 },
      fw: { type: 'integer', minimum: 0 },
      battery_mv: { type: 'integer', minimum: 0, maximum: 10000 },
      battery_pct: { type: 'integer', minimum: 0, maximum: 100 },
      rssi: { type: 'integer', minimum: -127, maximum: 0 },
      readings: {
        type: 'array',
        maxItems: 1000,
        items: {
          type: 'object',
          required: ['t'],
          properties: {
            ts: { type: 'integer', minimum: 0 },
            age_s: { type: 'integer', minimum: 0 },
            t: { type: 'number', minimum: -60, maximum: 150 },
          },
        },
      },
    },
  },
} as const;

const patchSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      name: { type: ['string', 'null'], maxLength: 64 },
      interval_s: { type: 'integer', minimum: 10, maximum: 86400 },
      batch: { type: 'integer', minimum: 1, maximum: 96 },
      alert_min: { type: 'number' },
      alert_max: { type: 'number' },
    },
  },
} as const;

async function readManifest(dir: string | undefined): Promise<Record<string, number>> {
  if (!dir) return {};
  try {
    return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

export async function buildApp(opts: AppOptions) {
  const { store } = opts;
  const now = opts.now ?? (() => new Date());
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 256 * 1024 });

  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)),
  });

  app.get('/healthz', async () => ({ ok: true }));

  app.register(
    async (api) => {
      api.post<{ Body: IngestBody }>(
        '/readings',
        { schema: ingestSchema, preHandler: requireToken(opts.ingestToken) },
        async (req, reply) => {
          const b = req.body;
          const received = now();
          const device = await store.upsertHeartbeat({
            deviceId: b.device_id,
            model: b.model,
            fw: b.fw,
            batteryMv: b.battery_mv,
            batteryPct: b.battery_pct,
            rssi: b.rssi,
            seenAt: received,
          });

          // Absolute timestamps win; nodes without a synced clock send ages.
          const maxFuture = received.getTime() + 5 * 60_000;
          const readings: Reading[] = [];
          for (const r of b.readings) {
            const ms =
              r.ts !== undefined ? r.ts * 1000 : r.age_s !== undefined ? received.getTime() - r.age_s * 1000 : received.getTime();
            if (ms > maxFuture) continue; // clock garbage
            readings.push({ ts: new Date(ms), t: r.t });
          }
          const inserted = await store.insertReadings(device.id, readings);

          const manifest = await readManifest(opts.firmwareDir);
          const fwVersion = b.model ? manifest[b.model] : undefined;
          return reply.code(201).send({
            accepted: readings.length,
            inserted,
            interval_s: device.intervalS,
            batch: device.batch,
            alert_min: device.alertMin,
            alert_max: device.alertMax,
            ...(fwVersion !== undefined && { fw_version: fwVersion }),
          });
        },
      );

      api.get<{ Params: { model: string } }>(
        '/firmware/:model',
        { preHandler: requireToken(opts.ingestToken) },
        async (req, reply) => {
          if (!opts.firmwareDir || !/^[A-Za-z0-9_-]+$/.test(req.params.model)) {
            return reply.code(404).send({ error: 'not_found' });
          }
          const file = join(opts.firmwareDir, `${req.params.model}.bin`);
          const info = await stat(file).catch(() => null);
          if (!info) return reply.code(404).send({ error: 'not_found' });
          return reply
            .header('content-type', 'application/octet-stream')
            .header('content-length', info.size)
            .send(createReadStream(file));
        },
      );

      api.get('/devices', async () => {
        const t = now();
        return (await store.listDevices()).map((d) => toDto(d, t));
      });

      api.get<{ Params: { id: string } }>('/devices/:id', async (req, reply) => {
        const d = await store.getDevice(req.params.id);
        return d ? toDto(d, now()) : reply.code(404).send({ error: 'not_found' });
      });

      api.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; limit?: number } }>(
        '/devices/:id/readings',
        {
          schema: {
            querystring: {
              type: 'object',
              properties: {
                from: { type: 'string', format: 'date-time' },
                to: { type: 'string', format: 'date-time' },
                limit: { type: 'integer', minimum: 1, maximum: 5000, default: 500 },
              },
            },
          },
        },
        async (req, reply) => {
          if (!(await store.getDevice(req.params.id))) return reply.code(404).send({ error: 'not_found' });
          const q = req.query;
          const rows = await store.getReadings(req.params.id, {
            from: q.from ? new Date(q.from) : undefined,
            to: q.to ? new Date(q.to) : undefined,
            limit: q.limit ?? 500,
          });
          return rows.map((r) => ({ ts: r.ts.toISOString(), t: r.t }));
        },
      );

      api.patch<{
        Params: { id: string };
        Body: { name?: string | null; interval_s?: number; batch?: number; alert_min?: number; alert_max?: number };
      }>('/devices/:id', { schema: patchSchema, preHandler: requireToken(opts.adminToken) }, async (req, reply) => {
        const b = req.body;
        const current = await store.getDevice(req.params.id);
        if (!current) return reply.code(404).send({ error: 'not_found' });
        if ((b.alert_min ?? current.alertMin) >= (b.alert_max ?? current.alertMax)) {
          return reply.code(400).send({ error: 'alert_min must be lower than alert_max' });
        }
        const d = await store.updateDevice(req.params.id, {
          name: b.name,
          intervalS: b.interval_s,
          batch: b.batch,
          alertMin: b.alert_min,
          alertMax: b.alert_max,
        });
        return toDto(d!, now());
      });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
