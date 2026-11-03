/**
 * Simulates a fleet of temperature nodes posting batches to the API, so the
 * dashboard and the Flutter app can be exercised without hardware.
 *
 *   npm run simulate                       # 3 nodes, 24 h backfill, then live
 *   API_URL=https://iot.example.com/api/v1 INGEST_TOKEN=... npm run simulate
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const TOKEN = process.env.INGEST_TOKEN ?? 'dev-ingest-token';
const INTERVAL_S = 300;
const BATCH = 6;
const SPEEDUP = Number(process.env.SPEEDUP ?? 60); // 1 simulated upload every 30 min / 60 = 30 s

interface SimNode {
  id: string;
  base: number;
  amplitude: number;
  batteryMv: number;
  /** Simulated door-open event that pushes the fridge out of range. */
  excursionAt?: number;
}

const nodes: SimNode[] = [
  { id: 'fridge-vaccines', base: 4.5, amplitude: 0.8, batteryMv: 4080, excursionAt: Date.now() - 3 * 3600_000 },
  { id: 'fridge-lab', base: 5.2, amplitude: 1.1, batteryMv: 3890 },
  { id: 'cold-room', base: 3.1, amplitude: 0.5, batteryMv: 3720 },
];

function temperatureAt(n: SimNode, ms: number): number {
  // Slow compressor/defrost cycle (~3 h) sampled every 5 min.
  const compressorCycle = Math.sin((ms / 3_600_000 / 3) * 2 * Math.PI + n.base) * n.amplitude;
  const noise = (Math.random() - 0.5) * 0.12;
  const sinceExcursion = n.excursionAt ? ms - n.excursionAt : -1;
  const excursion = sinceExcursion >= 0 && sinceExcursion < 70 * 60_000 ? 5.5 * Math.sin((sinceExcursion / (70 * 60_000)) * Math.PI) : 0;
  return Math.round((n.base + compressorCycle + noise + excursion) * 100) / 100;
}

async function post(n: SimNode, endMs: number): Promise<void> {
  const readings = Array.from({ length: BATCH }, (_, i) => {
    const ms = endMs - (BATCH - 1 - i) * INTERVAL_S * 1000;
    return { ts: Math.floor(ms / 1000), t: temperatureAt(n, ms) };
  });
  n.batteryMv = Math.max(3300, n.batteryMv - 1);
  const pct = Math.round(Math.min(100, Math.max(0, ((n.batteryMv - 3300) / 900) * 100)));
  const res = await fetch(`${API_URL}/readings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ device_id: n.id, model: 'temp-node', fw: 3, battery_mv: n.batteryMv, battery_pct: pct, rssi: -60, readings }),
  });
  if (!res.ok) throw new Error(`${n.id}: HTTP ${res.status} ${await res.text()}`);
}

const periodMs = INTERVAL_S * BATCH * 1000;
const now = Date.now();
for (let t = now - 24 * 3600_000; t <= now; t += periodMs) {
  await Promise.all(nodes.map((n) => post(n, t)));
}
console.log(`backfilled 24 h for ${nodes.length} nodes → ${API_URL}`);

setInterval(async () => {
  try {
    await Promise.all(nodes.map((n) => post(n, Date.now())));
    console.log(new Date().toISOString(), 'batch sent');
  } catch (e) {
    console.error(e);
  }
}, periodMs / SPEEDUP);
