#include "node_logic.h"

namespace node {

UploadReason shouldUpload(size_t buffered, size_t capacity, const Reading& latest,
                          const UploadPolicy& policy, bool firstBoot) {
  if (buffered == 0) return UploadReason::None;
  if (firstBoot) return UploadReason::FirstBoot;  // prove the setup works right away
  if (latest.centiC != kNoTemp &&
      (latest.centiC <= policy.alertLowCentiC || latest.centiC >= policy.alertHighCentiC)) {
    return UploadReason::Alert;
  }
  if (buffered >= capacity) return UploadReason::BufferFull;
  if (buffered >= policy.batchSize) return UploadReason::BatchReady;
  return UploadReason::None;
}

uint8_t batteryPercent(uint16_t mv) {
  // Resting voltage -> state of charge for a single Li-ion cell.
  struct Point {
    uint16_t mv;
    uint8_t pct;
  };
  static constexpr Point curve[] = {
      {3300, 0},  {3500, 5},  {3600, 10}, {3700, 25}, {3750, 40},
      {3800, 55}, {3900, 70}, {4000, 82}, {4100, 92}, {4200, 100},
  };
  constexpr size_t n = sizeof curve / sizeof curve[0];
  if (mv <= curve[0].mv) return 0;
  if (mv >= curve[n - 1].mv) return 100;
  for (size_t i = 1; i < n; ++i) {
    if (mv <= curve[i].mv) {
      const Point& a = curve[i - 1];
      const Point& b = curve[i];
      return a.pct + (uint32_t)(mv - a.mv) * (b.pct - a.pct) / (b.mv - a.mv);
    }
  }
  return 100;
}

}  // namespace node
