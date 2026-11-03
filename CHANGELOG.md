# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Firmware versions are integers (`FW_VERSION`) because the API compares them for OTA; the API uses Semantic Versioning.

## [1.0.0] - 2026-11-03

### Firmware (FW_VERSION 3)
- DS18B20 or SHT31 sampling before the radio is powered, with retries and a check for the DS18B20 85 °C power-on value.
- RTC-memory ring buffer (96 readings) that survives deep sleep and drops the oldest reading when full.
- Upload policy: batch ready, buffer full, alert range or first boot.
- Timestamps taken before the first SNTP sync are back-filled; `age_s` is sent when the clock never synced.
- Remote config (interval, batch, alert range) and OTA driven by the API response.
- Captive portal for Wi-Fi, API URL and token; serial provisioning on power-on.

### API
- `POST /readings` with idempotent inserts per `(device, ts)`.
- Device list with `ok` / `alert` / `stale` status, time series queries, settings via `PATCH`.
- Firmware hosting for OTA, PostgreSQL and in-memory stores, a dashboard and a fleet simulator.
