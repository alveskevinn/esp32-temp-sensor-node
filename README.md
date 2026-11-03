# esp32-temp-sensor-node

[![CI](https://github.com/alveskevinn/esp32-temp-sensor-node/actions/workflows/ci.yml/badge.svg)](https://github.com/alveskevinn/esp32-temp-sensor-node/actions/workflows/ci.yml)
![ESP32-C3](https://img.shields.io/badge/ESP32--C3-PlatformIO-orange?logo=espressif)
![Node](https://img.shields.io/badge/Node.js-24-339933?logo=node.js)
![License](https://img.shields.io/badge/license-MIT-blue)

A battery-powered **ESP32-C3** temperature node (DS18B20 or SHT31) and a minimal **ingest API and dashboard**. The node samples on a schedule and keeps readings in RTC memory across deep sleep. It wakes the Wi-Fi radio only to upload a batch, or right away when a reading leaves the alert range. Nothing is lost while the network is down.

![Dashboard showing a vaccine fridge excursion above 8 °C](docs/dashboard.png)

## Why

Cold-chain monitoring (vaccine and pharmacy fridges, cold rooms, food storage) needs three things: readings you can trust, alerts when something goes wrong, and a battery that lasts months. Most DIY nodes join Wi-Fi on every sample. That drains the battery in weeks, and readings vanish whenever the router is down.

This node separates **sampling** from **uploading**:

| | Typical DIY node | This node |
|---|---|---|
| Wi-Fi on | every sample | once per batch (default: 6 samples / 30 min) |
| Network down | reading lost | buffered in RTC RAM (96 readings ≈ 8 h), uploaded later |
| Out-of-range reading | seen on next upload | uploaded immediately |
| Retried upload | duplicates | idempotent per `(device, timestamp)` |
| No NTP yet | timestamps from 1970 | back-filled once the clock syncs |

## Architecture

```mermaid
flowchart LR
  subgraph Node["ESP32-C3 node (firmware/)"]
    S[DS18B20 / SHT31] --> R[(RTC ring buffer<br/>96 readings)]
    R --> P{upload policy<br/>batch · full · alert}
    P -- no --> Z[deep sleep]
    P -- yes --> W[Wi-Fi + SNTP] --> H[HTTPS POST batch]
    H --> Z
  end
  subgraph Cloud["API (backend/)"]
    A[Fastify API] --> DB[(PostgreSQL)]
    A --> UI[Dashboard]
    A --> F[firmware/*.bin<br/>OTA manifest]
  end
  H -- Bearer token --> A
  A -- interval · batch · alert range · fw_version --> H
  APP[flutter-iot-dashboard] --> A
```

One wake cycle, from [`firmware/src/main.cpp`](firmware/src/main.cpp):

```mermaid
sequenceDiagram
  participant N as Node
  participant A as API
  N->>N: wake (timer) → read sensor before radio
  N->>N: push to RTC buffer
  alt buffered < batch and reading within range
    N->>N: deep sleep
  else upload
    N->>N: Wi-Fi (12 s max, no portal) + SNTP, back-fill timestamps
    N->>A: POST /api/v1/readings {readings:[…]}
    A-->>N: 201 {interval_s, batch, alert_min, alert_max, fw_version?}
    N->>N: clear buffer, apply config, OTA if newer
    N->>N: deep sleep
  end
```

The hardware-independent logic is in [`firmware/lib/node_logic`](firmware/lib/node_logic): ring buffer, upload policy, clock back-fill and the Li-ion state-of-charge curve. It is unit-tested on the host.

### API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/readings` | ingest token | batch upload; returns remote config |
| `GET` | `/api/v1/firmware/:model` | ingest token | OTA image (`FIRMWARE_DIR/<model>.bin`) |
| `GET` | `/api/v1/devices` | – | devices with last reading, battery, `status` (`ok` / `alert` / `stale`) |
| `GET` | `/api/v1/devices/:id/readings?from&to&limit` | – | time series, oldest first |
| `PATCH` | `/api/v1/devices/:id` | admin token | name, interval, batch size, alert range (applied on the next upload) |

```json
POST /api/v1/readings
{
  "device_id": "fridge-01", "model": "temp-node", "fw": 3,
  "battery_mv": 3950, "battery_pct": 76, "rssi": -61,
  "readings": [ { "ts": 1762170600, "t": 4.56 }, { "age_s": 300, "t": 4.62 } ]
}
```

A reading carries an absolute `ts` when the node's clock is synced, or an `age_s` relative to the upload when it isn't. Readings dated more than 5 minutes in the future are dropped.

## Hardware / BOM

| Qty | Part | Notes |
|---|---|---|
| 1 | ESP32-C3 SuperMini (or DevKitM-1) | remove the power LED for long battery life |
| 1 | DS18B20 waterproof probe **or** SHT31 breakout | build env `esp32c3` / `esp32c3-sht31` |
| 1 | 4.7 kΩ resistor | DS18B20 data pull-up |
| 2 | 100 kΩ resistors | VBAT divider → ADC |
| 1 | 18650 Li-ion cell (or LiPo) + holder | |
| 1 | TP4056 charger with protection (optional) | |
| 1 | Low-Iq LDO, e.g. HT7333 / MCP1700 (if bypassing the board regulator) | |

### Wiring (ESP32-C3 SuperMini)

| ESP32-C3 | Connects to |
|---|---|
| GPIO4 | DS18B20 DQ (+ 4.7 kΩ to 3V3) |
| GPIO8 / GPIO9 | SHT31 SDA / SCL |
| GPIO3 | midpoint of the 100 k / 100 k divider from VBAT |
| GPIO9 (BOOT) | hold on reset → configuration portal |
| 3V3 / GND | sensor VCC / GND |

### Battery estimate

| Phase | Current | Duration | Every | Average |
|---|---|---|---|---|
| Sample (sensor + CPU) | ~20 mA | ~0.9 s | 5 min | ~60 µA |
| Upload (Wi-Fi + TLS) | ~110 mA | ~4 s | 30 min | ~245 µA |
| Deep sleep (bare module + divider) | ~30 µA | – | – | ~30 µA |
| **Total** | | | | **≈ 0.34 mA** |

That works out to about **8 months on a 2000 mAh cell**. Dev boards with an always-on LED or an inefficient LDO draw far more, so measure your board. Make batches longer for longer runtime.

## How to run

### Backend + dashboard

```bash
cd backend
npm install
npm run dev            # in-memory store, http://localhost:3000
npm run simulate       # in another terminal: 3 fake fridges, 24 h of history, then live
```

With PostgreSQL, from the repo root:

```bash
docker compose up --build    # db + api on http://localhost:3000
```

| Env var | Default (dev) | |
|---|---|---|
| `DATABASE_URL` | — (memory store) | `postgres://user:pass@host:5432/db` |
| `INGEST_TOKEN` | `dev-ingest-token` | required in production |
| `ADMIN_TOKEN` | `dev-admin-token` | required in production |
| `FIRMWARE_DIR` | — | folder with `<model>.bin` and `manifest.json` (`{"temp-node": 4}`) |

### Firmware

```bash
cd firmware
pio test -e native             # unit tests
pio run -e esp32c3 -t upload   # or esp32c3-sht31 / esp32dev
pio device monitor
```

1. On first power-on the node opens the `TempNode-XXXXXX` access point. Join it, choose your Wi-Fi network, and enter the **API base URL** (e.g. `https://iot.example.com/api/v1`) and the **device token**.
2. Optional serial provisioning in the first 3 s after power-on: `SETID:fridge-01`, `SETINT:300`, `SETBATCH:6`.
3. To release an OTA update, copy `.pio/build/esp32c3/firmware.bin` to `FIRMWARE_DIR/temp-node.bin` and bump `manifest.json`. Nodes update after their next upload.

## Security

- Tokens are compared in constant time. Read endpoints are public by design for the demo; put the API behind your gateway or add auth before exposing real data.
- The node uses `setInsecure()` TLS to save flash and RAM. For production, pin the server CA (`setCACert`), sign the firmware images, and enable flash encryption.

## Project layout

```text
firmware/   PlatformIO project (ESP32-C3, ESP32), node_logic library and native tests
backend/    Fastify + TypeScript API, PostgreSQL / in-memory stores, dashboard, simulator
docs/       images used in this README
```

## License

[MIT](LICENSE) © Kevin Pedroso · [DevSkin](https://devskin.com)
