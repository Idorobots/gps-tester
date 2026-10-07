import { describe, expect, it } from "vitest";
import { BLE_RESUBSCRIBE_AFTER_MS, watchdogDue } from "../src/bluetooth";

describe("watchdogDue", () => {
  it("is not due while data is flowing", () => {
    const now = 100_000;
    expect(watchdogDue(now, now - 3_000, 0, false)).toBe(false);
  });

  it("becomes due after the silence threshold", () => {
    const now = 100_000;
    expect(watchdogDue(now, now - (BLE_RESUBSCRIBE_AFTER_MS + 5_000), 0, false)).toBe(true);
  });

  it("does not re-trigger immediately after a previous action", () => {
    const now = 100_000;
    expect(watchdogDue(now, now - (BLE_RESUBSCRIBE_AFTER_MS + 5_000), now - 5_000, false)).toBe(false);
  });

  it("re-triggers after another full silence window", () => {
    const now = 100_000;
    expect(watchdogDue(now, now - (BLE_RESUBSCRIBE_AFTER_MS + 5_000), now - (BLE_RESUBSCRIBE_AFTER_MS + 1_000), false)).toBe(true);
  });

  it("is suppressed while a reconnect is in progress", () => {
    const now = 100_000;
    expect(watchdogDue(now, now - 60_000, 0, true)).toBe(false);
  });

  it("is due when no data was ever received and the window has passed", () => {
    const now = 100_000;
    expect(watchdogDue(now, null, now - (BLE_RESUBSCRIBE_AFTER_MS + 2_000), false)).toBe(true);
  });
});