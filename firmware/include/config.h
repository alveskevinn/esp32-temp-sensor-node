#pragma once

#define FW_MODEL "temp-node"
#define FW_VERSION 3  // integer: the API compares it to offer OTA updates

// --- Wiring (ESP32-C3 SuperMini defaults) -----------------------------------
#ifndef ONE_WIRE_GPIO
#define ONE_WIRE_GPIO 4  // DS18B20 DQ, 4.7 kΩ pull-up to 3V3
#endif
#ifndef I2C_SDA_GPIO
#define I2C_SDA_GPIO 8  // SHT31 (only with -DSENSOR_SHT31)
#endif
#ifndef I2C_SCL_GPIO
#define I2C_SCL_GPIO 9
#endif
#ifndef BATTERY_ADC_GPIO
#define BATTERY_ADC_GPIO 3  // middle of a 100k/100k divider from VBAT
#endif
#define BATTERY_DIVIDER 2.0f
#ifndef PORTAL_BUTTON_GPIO
#define PORTAL_BUTTON_GPIO 9  // BOOT button on the C3 SuperMini; hold on reset
#endif

// --- Defaults (all editable at runtime) --------------------------------------
#define DEFAULT_INTERVAL_S 300  // one reading every 5 min
#define DEFAULT_BATCH 6         // ... uploaded every 30 min
#define DEFAULT_ALERT_LOW_C 2.0f
#define DEFAULT_ALERT_HIGH_C 8.0f  // vaccine / pharma fridge range
#define BUFFER_CAPACITY 96         // 8 h of readings at the default interval

#define PORTAL_AP_PREFIX "TempNode-"
#define PORTAL_TIMEOUT_S 180
#define WIFI_CONNECT_TIMEOUT_MS 12000
#define HTTP_TIMEOUT_MS 10000
