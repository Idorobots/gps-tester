import { describe, expect, it } from "vitest";
import { retry, type SleepFn } from "../src/retry";

const noSleep: SleepFn = async () => {};

describe("retry", () => {
  it("returns the value on first success", async () => {
    const calls: number[] = [];
    const result = await retry(3, async (attempt) => {
      calls.push(attempt);
      return "ok";
    }, noSleep);
    expect(result).toBe("ok");
    expect(calls).toEqual([1]);
  });

  it("retries until success", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const result = await retry(5, async () => {
      attempts++;
      if (attempts < 3) throw new Error("flaky");
      return attempts;
    }, async (ms) => {
      sleeps.push(ms);
    }, 1000);
    expect(result).toBe(3);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("throws the last error when attempts are exhausted", async () => {
    const errors: Error[] = [];
    await expect(
      retry(3, async () => {
        const err = new Error(`fail ${errors.length}`);
        errors.push(err);
        throw err;
      }, noSleep),
    ).rejects.toThrow("fail 2");
    expect(errors).toHaveLength(3);
  });

  it("does not sleep after the final attempt", async () => {
    let sleeps = 0;
    await expect(
      retry(2, async () => {
        throw new Error("always");
      }, async () => {
        sleeps++;
      }),
    ).rejects.toThrow("always");
    expect(sleeps).toBe(1);
  });
});