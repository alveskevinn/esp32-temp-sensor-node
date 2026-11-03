// ESP32-C3 battery temperature node.
//
// Every wake cycle runs entirely in setup():
//   1. read the sensor (before the radio: less self-heating, less noise)
//   2. append the reading to a ring buffer kept in RTC memory
//   3. only if the upload policy says so, bring Wi-Fi up and POST the whole
//      batch; readings stay buffered until the API acknowledges them
//   4. apply remote config / OTA from the response, then deep sleep
// loop() never runs.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <node_logic.h>
#include <time.h>

#include "config.h"

#ifdef SENSOR_SHT31
#include <Adafruit_SHT31.h>
#include <Wire.h>
#else
#include <DallasTemperature.h>
#include <OneWire.h>
#endif

using node::Reading;

// ---------------------------------------------------------------------------
// State that survives deep sleep (lost on power-on reset only).
RTC_DATA_ATTR static node::ReadingBuffer<BUFFER_CAPACITY> buffer;
RTC_DATA_ATTR static uint32_t bootCount = 0;
RTC_DATA_ATTR static uint32_t failedUploads = 0;

struct Config {
  String deviceId;
  String apiUrl;  // e.g. https://iot.example.com/api/v1
  String token;
  uint32_t intervalS;
  uint16_t batch;
  float alertLowC;
  float alertHighC;
};

static Config cfg;
static Preferences prefs;

static void loadConfig() {
  prefs.begin("tempnode", false);
  char defId[24];
  snprintf(defId, sizeof defId, "temp-%06llx", ESP.getEfuseMac() & 0xFFFFFFULL);
  cfg.deviceId = prefs.getString("id", defId);
  cfg.apiUrl = prefs.getString("api", "");
  cfg.token = prefs.getString("token", "");
  cfg.intervalS = prefs.getUInt("interval", DEFAULT_INTERVAL_S);
  cfg.batch = prefs.getUShort("batch", DEFAULT_BATCH);
  cfg.alertLowC = prefs.getFloat("alert_lo", DEFAULT_ALERT_LOW_C);
  cfg.alertHighC = prefs.getFloat("alert_hi", DEFAULT_ALERT_HIGH_C);
}

// ---------------------------------------------------------------------------
// Serial provisioning: only offered on power-on, never on timer wakes, so the
// 3 s window does not cost battery on every cycle.
static void serialProvisioning() {
  const uint32_t deadline = millis() + 3000;
  uint32_t until = deadline;
  while (millis() < until) {
    if (!Serial.available()) {
      delay(10);
      continue;
    }
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.startsWith("SETID:")) {
      cfg.deviceId = cmd.substring(6);
      prefs.putString("id", cfg.deviceId);
    } else if (cmd.startsWith("SETINT:")) {
      const long s = cmd.substring(7).toInt();
      if (s >= 10 && s <= 86400) prefs.putUInt("interval", cfg.intervalS = s);
    } else if (cmd.startsWith("SETBATCH:")) {
      const long n = cmd.substring(9).toInt();
      if (n >= 1 && n <= BUFFER_CAPACITY) prefs.putUShort("batch", cfg.batch = n);
    }
    Serial.printf("CFG id=%s int=%lu batch=%u api=%s\n", cfg.deviceId.c_str(),
                  (unsigned long)cfg.intervalS, cfg.batch, cfg.apiUrl.c_str());
    until = millis() + 3000;  // keep the window open while someone is typing
  }
}

// ---------------------------------------------------------------------------
static int16_t readTemperatureCentiC() {
#ifdef SENSOR_SHT31
  Wire.begin(I2C_SDA_GPIO, I2C_SCL_GPIO);
  Adafruit_SHT31 sht;
  if (!sht.begin(0x44)) return node::kNoTemp;
  const float c = sht.readTemperature();
  return isnan(c) ? node::kNoTemp : (int16_t)lroundf(c * 100.0f);
#else
  OneWire bus(ONE_WIRE_GPIO);
  DallasTemperature ds(&bus);
  ds.begin();
  for (int attempt = 0; attempt < 3; ++attempt) {
    ds.requestTemperatures();
    const float c = ds.getTempCByIndex(0);
    // 85.0 is the DS18B20 power-on value: the conversion did not run
    // (loose data wire / weak pull-up). -127 means no sensor answered.
    if (c != DEVICE_DISCONNECTED_C && c != 85.0f) return (int16_t)lroundf(c * 100.0f);
    delay(150);
  }
  return node::kNoTemp;
#endif
}

static uint16_t readBatteryMv() {
  uint32_t sum = 0;
  for (int i = 0; i < 8; ++i) sum += analogReadMilliVolts(BATTERY_ADC_GPIO);
  return (uint16_t)(sum / 8 * BATTERY_DIVIDER);
}

// ---------------------------------------------------------------------------
static bool connectWifi(bool openPortal) {
  WiFi.mode(WIFI_STA);
  WiFiManager wm;
  wm.setConfigPortalTimeout(PORTAL_TIMEOUT_S);

  // Routine cycle with saved credentials: try quickly, never open the portal
  // (a portal waiting 3 min on every bad Wi-Fi day would drain the battery).
  if (!openPortal && wm.getWiFiIsSaved()) {
    WiFi.begin();
    const uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_CONNECT_TIMEOUT_MS) delay(100);
    return WiFi.status() == WL_CONNECTED;
  }

  WiFiManagerParameter pApi("api", "API base URL", cfg.apiUrl.c_str(), 120);
  WiFiManagerParameter pToken("token", "Device token", cfg.token.c_str(), 80, "type='password'");
  WiFiManagerParameter pId("id", "Device id", cfg.deviceId.c_str(), 31);
  wm.addParameter(&pApi);
  wm.addParameter(&pToken);
  wm.addParameter(&pId);
  bool saved = false;
  wm.setSaveParamsCallback([&saved]() { saved = true; });
  wm.setSaveConfigCallback([&saved]() { saved = true; });

  char ap[24];
  snprintf(ap, sizeof ap, PORTAL_AP_PREFIX "%06llX", ESP.getEfuseMac() & 0xFFFFFFULL);
  const bool ok = openPortal ? wm.startConfigPortal(ap) : wm.autoConnect(ap);
  if (saved) {
    prefs.putString("api", cfg.apiUrl = pApi.getValue());
    prefs.putString("token", cfg.token = pToken.getValue());
    if (strlen(pId.getValue())) prefs.putString("id", cfg.deviceId = pId.getValue());
  }
  return ok;
}

// First successful SNTP sync rewrites timestamps taken while the clock was
// still counting from power-on.
static void syncClock() {
  const time_t before = time(nullptr);
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  for (int i = 0; i < 40 && time(nullptr) < node::kValidEpoch; ++i) delay(100);
  const time_t after = time(nullptr);
  if (before < node::kValidEpoch && after >= node::kValidEpoch) {
    buffer.backfill((uint32_t)(after - before));
  }
}

static String apiUrl(const char* path) {
  String base = cfg.apiUrl;
  if (base.endsWith("/")) base.remove(base.length() - 1);
  return base + path;
}

// POSTs every buffered reading. Returns the latest firmware version offered
// by the API (0 = none) through `fwLatest`.
static bool upload(uint32_t& fwLatest) {
  const size_t n = buffer.size();
  JsonDocument doc;
  doc["device_id"] = cfg.deviceId;
  doc["model"] = FW_MODEL;
  doc["fw"] = FW_VERSION;
  doc["battery_mv"] = buffer.at(n - 1).batteryMv;
  doc["battery_pct"] = node::batteryPercent(buffer.at(n - 1).batteryMv);
  doc["rssi"] = WiFi.RSSI();
  doc["dropped"] = buffer.dropped;
  doc["failed_uploads"] = failedUploads;
  JsonArray arr = doc["readings"].to<JsonArray>();
  for (size_t i = 0; i < n; ++i) {
    const Reading& r = buffer.at(i);
    if (r.centiC == node::kNoTemp) continue;
    JsonObject o = arr.add<JsonObject>();
    // Unsynced timestamps are sent as relative ages so the API can place them.
    if (r.ts >= node::kValidEpoch) {
      o["ts"] = r.ts;
    } else {
      o["age_s"] = (uint32_t)time(nullptr) - r.ts;
    }
    o["t"] = r.centiC / 100.0;
  }
  String body;
  serializeJson(doc, body);

  bool ok = false;
  {
    // Own scope: this TLS context must be freed before OTA opens another one;
    // two concurrent TLS sessions do not fit in the C3's RAM.
    WiFiClientSecure tls;
    tls.setInsecure();  // see README "Security" for CA pinning
    HTTPClient http;
    http.setConnectTimeout(HTTP_TIMEOUT_MS);
    http.setTimeout(HTTP_TIMEOUT_MS);
    if (http.begin(tls, apiUrl("/readings"))) {
      http.addHeader("Content-Type", "application/json");
      http.addHeader("Authorization", "Bearer " + cfg.token);
      const int code = http.POST(body);
      Serial.printf("POST %d (%u readings)\n", code, (unsigned)n);
      if (code >= 200 && code < 300) {
        ok = true;
        JsonDocument resp;
        if (!deserializeJson(resp, http.getString())) {
          // Remote configuration, applied from the next cycle on.
          const uint32_t interval = resp["interval_s"] | 0u;
          if (interval >= 10 && interval <= 86400 && interval != cfg.intervalS)
            prefs.putUInt("interval", cfg.intervalS = interval);
          const uint16_t batch = resp["batch"] | 0u;
          if (batch >= 1 && batch <= BUFFER_CAPACITY && batch != cfg.batch)
            prefs.putUShort("batch", cfg.batch = batch);
          if (resp["alert_min"].is<float>()) prefs.putFloat("alert_lo", resp["alert_min"]);
          if (resp["alert_max"].is<float>()) prefs.putFloat("alert_hi", resp["alert_max"]);
          fwLatest = resp["fw_version"] | 0u;
        }
      }
      http.end();
    }
  }
  return ok;
}

static void tryOta(uint32_t fwLatest) {
  if (fwLatest <= FW_VERSION) return;
  Serial.printf("OTA v%d -> v%lu\n", FW_VERSION, (unsigned long)fwLatest);
  WiFiClientSecure tls;
  tls.setInsecure();
  tls.setTimeout(20);  // seconds; a dead link must not hang the node forever
  const String auth = "Bearer " + cfg.token;
  const auto ret =
      httpUpdate.update(tls, apiUrl("/firmware/" FW_MODEL), String(FW_VERSION),
                        [&auth](HTTPClient* c) { c->addHeader("Authorization", auth); });
  // Success reboots; reaching this line means it failed. Carry on to sleep.
  Serial.printf("OTA failed (%d): %s\n", (int)ret, httpUpdate.getLastErrorString().c_str());
}

[[noreturn]] static void sleepNow() {
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  esp_sleep_enable_timer_wakeup((uint64_t)cfg.intervalS * 1000000ULL);
  esp_deep_sleep_start();
}

void setup() {
  const bool powerOn = esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_UNDEFINED;
  if (powerOn) {
    buffer.clear();
    buffer.dropped = 0;
    failedUploads = 0;
  }
  bootCount++;

  Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(0);  // do not block on prints when no USB host is attached
#endif
  pinMode(PORTAL_BUTTON_GPIO, INPUT_PULLUP);
  loadConfig();
  if (powerOn) serialProvisioning();

  // 1. Measure before the radio is powered.
  const Reading reading{(uint32_t)time(nullptr), readTemperatureCentiC(), readBatteryMv()};
  buffer.push(reading);
  Serial.printf("#%lu t=%.2f vbat=%u buffered=%u\n", (unsigned long)bootCount,
                reading.centiC == node::kNoTemp ? NAN : reading.centiC / 100.0, reading.batteryMv,
                (unsigned)buffer.size());

  // 2. Decide whether this cycle pays the cost of Wi-Fi.
  const bool portal = digitalRead(PORTAL_BUTTON_GPIO) == LOW || cfg.apiUrl.isEmpty();
  const node::UploadPolicy policy{cfg.batch, (int16_t)lroundf(cfg.alertLowC * 100),
                                  (int16_t)lroundf(cfg.alertHighC * 100)};
  const auto reason =
      shouldUpload(buffer.size(), buffer.capacity(), reading, policy, powerOn || portal);
  if (reason == node::UploadReason::None) sleepNow();

  // 3. Upload the batch; keep it buffered on any failure.
  if (connectWifi(portal)) {
    syncClock();
    uint32_t fwLatest = 0;
    if (upload(fwLatest)) {
      buffer.clear();
      buffer.dropped = 0;
      failedUploads = 0;
      tryOta(fwLatest);
    } else {
      failedUploads++;
    }
  } else {
    failedUploads++;
  }
  sleepNow();
}

void loop() {}  // never reached: every wake restarts from setup()
