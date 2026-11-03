export interface DeviceSettings {
  name: string | null;
  intervalS: number;
  batch: number;
  alertMin: number;
  alertMax: number;
}

export interface Device extends DeviceSettings {
  id: string;
  model: string | null;
  fw: number | null;
  batteryMv: number | null;
  batteryPct: number | null;
  rssi: number | null;
  lastSeen: Date | null;
  lastTemp: number | null;
  lastReadingAt: Date | null;
}

export interface Heartbeat {
  deviceId: string;
  model?: string;
  fw?: number;
  batteryMv?: number;
  batteryPct?: number;
  rssi?: number;
  seenAt: Date;
}

export interface Reading {
  ts: Date;
  t: number;
}

export interface ReadingQuery {
  from?: Date;
  to?: Date;
  limit: number;
}

export interface Store {
  /** Creates the device on first contact and updates its health fields. */
  upsertHeartbeat(hb: Heartbeat): Promise<Device>;
  /** Idempotent per (device, ts): a retried batch never duplicates rows. Returns rows inserted. */
  insertReadings(deviceId: string, readings: Reading[]): Promise<number>;
  listDevices(): Promise<Device[]>;
  getDevice(id: string): Promise<Device | null>;
  /** Oldest first. */
  getReadings(deviceId: string, q: ReadingQuery): Promise<Reading[]>;
  updateDevice(id: string, patch: Partial<DeviceSettings>): Promise<Device | null>;
  close(): Promise<void>;
}

export const DEFAULT_SETTINGS: DeviceSettings = {
  name: null,
  intervalS: 300,
  batch: 6,
  alertMin: 2,
  alertMax: 8,
};
