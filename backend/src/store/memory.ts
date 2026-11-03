import { DEFAULT_SETTINGS, type Device, type DeviceSettings, type Heartbeat, type Reading, type ReadingQuery, type Store } from './types.js';

/** In-process store for development, demos and tests. Data is lost on restart. */
export class MemoryStore implements Store {
  private devices = new Map<string, Device>();
  private readings = new Map<string, Map<number, number>>(); // deviceId -> ts(ms) -> t

  async upsertHeartbeat(hb: Heartbeat): Promise<Device> {
    const current = this.devices.get(hb.deviceId) ?? {
      id: hb.deviceId,
      ...DEFAULT_SETTINGS,
      model: null,
      fw: null,
      batteryMv: null,
      batteryPct: null,
      rssi: null,
      lastSeen: null,
      lastTemp: null,
      lastReadingAt: null,
    };
    const next: Device = {
      ...current,
      model: hb.model ?? current.model,
      fw: hb.fw ?? current.fw,
      batteryMv: hb.batteryMv ?? current.batteryMv,
      batteryPct: hb.batteryPct ?? current.batteryPct,
      rssi: hb.rssi ?? current.rssi,
      lastSeen: hb.seenAt,
    };
    this.devices.set(hb.deviceId, next);
    return { ...next };
  }

  async insertReadings(deviceId: string, readings: Reading[]): Promise<number> {
    const series = this.readings.get(deviceId) ?? new Map<number, number>();
    this.readings.set(deviceId, series);
    let inserted = 0;
    for (const r of readings) {
      const key = r.ts.getTime();
      if (series.has(key)) continue;
      series.set(key, r.t);
      inserted++;
    }
    const device = this.devices.get(deviceId);
    if (device && series.size > 0) {
      const latest = Math.max(...series.keys());
      device.lastReadingAt = new Date(latest);
      device.lastTemp = series.get(latest) ?? null;
    }
    return inserted;
  }

  async listDevices(): Promise<Device[]> {
    return [...this.devices.values()].map((d) => ({ ...d })).sort((a, b) => a.id.localeCompare(b.id));
  }

  async getDevice(id: string): Promise<Device | null> {
    const d = this.devices.get(id);
    return d ? { ...d } : null;
  }

  async getReadings(deviceId: string, q: ReadingQuery): Promise<Reading[]> {
    const series = this.readings.get(deviceId);
    if (!series) return [];
    const from = q.from?.getTime() ?? -Infinity;
    const to = q.to?.getTime() ?? Infinity;
    return [...series.entries()]
      .filter(([ts]) => ts >= from && ts <= to)
      .sort(([a], [b]) => a - b)
      .slice(-q.limit)
      .map(([ts, t]) => ({ ts: new Date(ts), t }));
  }

  async updateDevice(id: string, patch: Partial<DeviceSettings>): Promise<Device | null> {
    const d = this.devices.get(id);
    if (!d) return null;
    // Only apply provided keys: `{ batch: undefined }` must not erase a setting.
    for (const [key, value] of Object.entries(patch) as [keyof DeviceSettings, never][]) {
      if (value !== undefined) d[key] = value;
    }
    return { ...d };
  }

  async close(): Promise<void> {}
}
