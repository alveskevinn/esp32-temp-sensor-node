import { readFile } from 'node:fs/promises';
import pg from 'pg';
import type { Device, DeviceSettings, Heartbeat, Reading, ReadingQuery, Store } from './types.js';

interface DeviceRow {
  id: string;
  name: string | null;
  model: string | null;
  fw: number | null;
  battery_mv: number | null;
  battery_pct: number | null;
  rssi: number | null;
  interval_s: number;
  batch: number;
  alert_min: number;
  alert_max: number;
  last_seen: Date | null;
  last_temp: number | null;
  last_reading_at: Date | null;
}

const DEVICE_SELECT = `
  SELECT d.*, r.temperature AS last_temp, r.ts AS last_reading_at
  FROM devices d
  LEFT JOIN LATERAL (
    SELECT temperature, ts FROM readings WHERE device_id = d.id ORDER BY ts DESC LIMIT 1
  ) r ON true`;

const toDevice = (r: DeviceRow): Device => ({
  id: r.id,
  name: r.name,
  model: r.model,
  fw: r.fw,
  batteryMv: r.battery_mv,
  batteryPct: r.battery_pct,
  rssi: r.rssi,
  intervalS: r.interval_s,
  batch: r.batch,
  alertMin: r.alert_min,
  alertMax: r.alert_max,
  lastSeen: r.last_seen,
  lastTemp: r.last_temp,
  lastReadingAt: r.last_reading_at,
});

const COLUMN: Record<keyof DeviceSettings, string> = {
  name: 'name',
  intervalS: 'interval_s',
  batch: 'batch',
  alertMin: 'alert_min',
  alertMax: 'alert_max',
};

export class PostgresStore implements Store {
  private constructor(private readonly pool: pg.Pool) {}

  static async connect(connectionString: string): Promise<PostgresStore> {
    // REAL columns come back as JS numbers; keep timestamptz as Date (default).
    const pool = new pg.Pool({ connectionString, max: 10 });
    const sql = await readFile(new URL('../../migrations/001_init.sql', import.meta.url), 'utf8');
    await pool.query(sql);
    return new PostgresStore(pool);
  }

  async upsertHeartbeat(hb: Heartbeat): Promise<Device> {
    await this.pool.query(
      `INSERT INTO devices (id, model, fw, battery_mv, battery_pct, rssi, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         model = COALESCE(EXCLUDED.model, devices.model),
         fw = COALESCE(EXCLUDED.fw, devices.fw),
         battery_mv = COALESCE(EXCLUDED.battery_mv, devices.battery_mv),
         battery_pct = COALESCE(EXCLUDED.battery_pct, devices.battery_pct),
         rssi = COALESCE(EXCLUDED.rssi, devices.rssi),
         last_seen = EXCLUDED.last_seen`,
      [hb.deviceId, hb.model ?? null, hb.fw ?? null, hb.batteryMv ?? null, hb.batteryPct ?? null, hb.rssi ?? null, hb.seenAt],
    );
    return (await this.getDevice(hb.deviceId))!;
  }

  async insertReadings(deviceId: string, readings: Reading[]): Promise<number> {
    if (readings.length === 0) return 0;
    const res = await this.pool.query(
      `INSERT INTO readings (device_id, ts, temperature)
       SELECT $1, * FROM UNNEST($2::timestamptz[], $3::real[])
       ON CONFLICT (device_id, ts) DO NOTHING`,
      [deviceId, readings.map((r) => r.ts), readings.map((r) => r.t)],
    );
    return res.rowCount ?? 0;
  }

  async listDevices(): Promise<Device[]> {
    const res = await this.pool.query<DeviceRow>(`${DEVICE_SELECT} ORDER BY d.id`);
    return res.rows.map(toDevice);
  }

  async getDevice(id: string): Promise<Device | null> {
    const res = await this.pool.query<DeviceRow>(`${DEVICE_SELECT} WHERE d.id = $1`, [id]);
    return res.rows[0] ? toDevice(res.rows[0]) : null;
  }

  async getReadings(deviceId: string, q: ReadingQuery): Promise<Reading[]> {
    const res = await this.pool.query<{ ts: Date; temperature: number }>(
      `SELECT ts, temperature FROM (
         SELECT ts, temperature FROM readings
         WHERE device_id = $1
           AND ($2::timestamptz IS NULL OR ts >= $2)
           AND ($3::timestamptz IS NULL OR ts <= $3)
         ORDER BY ts DESC LIMIT $4
       ) latest ORDER BY ts`,
      [deviceId, q.from ?? null, q.to ?? null, q.limit],
    );
    return res.rows.map((r) => ({ ts: r.ts, t: r.temperature }));
  }

  async updateDevice(id: string, patch: Partial<DeviceSettings>): Promise<Device | null> {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof DeviceSettings, unknown][];
    if (entries.length > 0) {
      const sets = entries.map(([k], i) => `${COLUMN[k]} = $${i + 2}`).join(', ');
      await this.pool.query(`UPDATE devices SET ${sets} WHERE id = $1`, [id, ...entries.map(([, v]) => v)]);
    }
    return this.getDevice(id);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
