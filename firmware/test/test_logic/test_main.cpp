#include <node_logic.h>
#include <unity.h>

using namespace node;

static ReadingBuffer<4> buf;

void setUp() {
  buf.clear();
  buf.dropped = 0;
}
void tearDown() {}

static Reading r(uint32_t ts, int16_t c = 2000) {
  return Reading{ts, c, 3900};
}

static void test_buffer_keeps_order() {
  buf.push(r(1));
  buf.push(r(2));
  buf.push(r(3));
  TEST_ASSERT_EQUAL(3, buf.size());
  TEST_ASSERT_EQUAL_UINT32(1, buf.at(0).ts);
  TEST_ASSERT_EQUAL_UINT32(3, buf.at(2).ts);
}

static void test_buffer_drops_oldest_when_full() {
  for (uint32_t i = 1; i <= 6; ++i) buf.push(r(i));
  TEST_ASSERT_TRUE(buf.full());
  TEST_ASSERT_EQUAL_UINT32(2, buf.dropped);
  TEST_ASSERT_EQUAL_UINT32(3, buf.at(0).ts);
  TEST_ASSERT_EQUAL_UINT32(6, buf.at(3).ts);
}

static void test_consume_partial_and_all() {
  for (uint32_t i = 1; i <= 4; ++i) buf.push(r(i));
  buf.consume(3);
  TEST_ASSERT_EQUAL(1, buf.size());
  TEST_ASSERT_EQUAL_UINT32(4, buf.at(0).ts);
  buf.push(r(5));
  TEST_ASSERT_EQUAL_UINT32(5, buf.at(1).ts);
  buf.consume(10);
  TEST_ASSERT_EQUAL(0, buf.size());
}

static void test_backfill_only_touches_unsynced() {
  buf.push(r(100));
  buf.push(r(160));
  buf.push(r(kValidEpoch + 5));
  buf.backfill(kValidEpoch);
  TEST_ASSERT_EQUAL_UINT32(kValidEpoch + 100, buf.at(0).ts);
  TEST_ASSERT_EQUAL_UINT32(kValidEpoch + 160, buf.at(1).ts);
  TEST_ASSERT_EQUAL_UINT32(kValidEpoch + 5, buf.at(2).ts);
}

static void test_upload_policy() {
  const UploadPolicy p{3, 200, 800};  // batch of 3, alert outside 2..8 °C
  TEST_ASSERT_EQUAL(UploadReason::None, shouldUpload(0, 4, r(1, 500), p, true));
  TEST_ASSERT_EQUAL(UploadReason::FirstBoot, shouldUpload(1, 4, r(1, 500), p, true));
  TEST_ASSERT_EQUAL(UploadReason::None, shouldUpload(2, 4, r(1, 500), p, false));
  TEST_ASSERT_EQUAL(UploadReason::BatchReady, shouldUpload(3, 4, r(1, 500), p, false));
  TEST_ASSERT_EQUAL(UploadReason::BufferFull, shouldUpload(4, 4, r(1, 500), p, false));
  TEST_ASSERT_EQUAL(UploadReason::Alert, shouldUpload(1, 4, r(1, 950), p, false));
  TEST_ASSERT_EQUAL(UploadReason::Alert, shouldUpload(1, 4, r(1, 150), p, false));
  TEST_ASSERT_EQUAL(UploadReason::None, shouldUpload(1, 4, r(1, kNoTemp), p, false));
}

static void test_battery_curve() {
  TEST_ASSERT_EQUAL_UINT8(0, batteryPercent(3000));
  TEST_ASSERT_EQUAL_UINT8(0, batteryPercent(3300));
  TEST_ASSERT_EQUAL_UINT8(70, batteryPercent(3900));
  TEST_ASSERT_EQUAL_UINT8(76, batteryPercent(3950));
  TEST_ASSERT_EQUAL_UINT8(100, batteryPercent(4250));
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_buffer_keeps_order);
  RUN_TEST(test_buffer_drops_oldest_when_full);
  RUN_TEST(test_consume_partial_and_all);
  RUN_TEST(test_backfill_only_touches_unsynced);
  RUN_TEST(test_upload_policy);
  RUN_TEST(test_battery_curve);
  return UNITY_END();
}
