// Hardware-independent logic of the sensor node: the offline reading buffer,
// the upload policy, clock back-filling and battery estimation.
// Unit-tested on the host with `pio test -e native`.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace node {

// Anything before 2023-11-14 means the RTC was never synced via SNTP: the
// ESP32 clock then counts seconds since the first power-on.
constexpr uint32_t kValidEpoch = 1700000000;

struct Reading {
  uint32_t ts;     // unix seconds (or seconds since power-on, see kValidEpoch)
  int16_t centiC;  // temperature x100; kNoTemp when the sensor failed
  uint16_t batteryMv;
};

constexpr int16_t kNoTemp = INT16_MIN;

// Fixed-capacity FIFO that drops the oldest reading when full. Lives in RTC
// memory (RTC_DATA_ATTR) so it survives deep sleep; must stay a POD.
template <size_t N>
struct ReadingBuffer {
  Reading items[N];
  uint16_t head;  // index of the oldest reading
  uint16_t count;
  uint32_t dropped;  // readings overwritten while offline

  void clear() { head = count = 0; }
  size_t size() const { return count; }
  static constexpr size_t capacity() { return N; }
  bool full() const { return count == N; }

  void push(const Reading& r) {
    const size_t tail = (head + count) % N;
    items[tail] = r;
    if (count < N) {
      ++count;
    } else {
      head = (head + 1) % N;
      ++dropped;
    }
  }

  // i = 0 is the oldest reading.
  const Reading& at(size_t i) const { return items[(head + i) % N]; }
  Reading& at(size_t i) { return items[(head + i) % N]; }

  // Removes the `n` oldest readings (after they were acknowledged by the API).
  void consume(size_t n) {
    if (n >= count) {
      clear();
      return;
    }
    head = (head + n) % N;
    count -= n;
  }

  // After the first SNTP sync, rewrites timestamps taken before it.
  // `shift` = synced epoch - unsynced clock value at the same instant.
  void backfill(uint32_t shift) {
    for (size_t i = 0; i < count; ++i) {
      Reading& r = at(i);
      if (r.ts < kValidEpoch) r.ts += shift;
    }
  }
};

struct UploadPolicy {
  uint16_t batchSize;  // upload once this many readings are buffered
  int16_t alertLowCentiC;
  int16_t alertHighCentiC;
};

enum class UploadReason : uint8_t { None, BatchReady, BufferFull, Alert, FirstBoot };

// Decides whether this wake cycle should power up Wi-Fi.
UploadReason shouldUpload(size_t buffered, size_t capacity, const Reading& latest,
                          const UploadPolicy& policy, bool firstBoot);

// Single-cell Li-ion/LiPo state of charge from the resting voltage (mV),
// piecewise-linear over a typical discharge curve. Returns 0..100.
uint8_t batteryPercent(uint16_t mv);

}  // namespace node
