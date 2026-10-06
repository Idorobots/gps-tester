import { afterEach, describe, expect, it, vi } from "vitest";
import { NmeaSimulator } from "../src/simulator";
import { applyLine, createGnssState, parseSentence, type GnssState } from "../src/nmea";

function feedFrame(state: GnssState, lines: string[]): void {
  for (const line of lines) applyLine(state, line);
}

describe("NmeaSimulator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("produces checksum-valid NMEA sentences", () => {
    const sim = new NmeaSimulator();
    const lines = sim.next(new Date(Date.UTC(2024, 0, 1, 12, 0, 0)));
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) {
      expect(parseSentence(line)).not.toBeNull();
    }
  });

  it("emits one second of movement per frame along the course", () => {
    const sim = new NmeaSimulator({ lat: 48.1, lon: 11.5, speedKmh: 100, courseDeg: 90 });
    const state = createGnssState();
    for (let i = 0; i < 60; i++) feedFrame(state, sim.next(new Date(Date.UTC(2024, 0, 1, 12, 0, i))));
    expect(state.lat).toBeCloseTo(48.1, 4);
    expect(state.lon).toBeGreaterThan(11.52);
  });

  it("reports a full 3D fix with satellites in view", () => {
    const sim = new NmeaSimulator();
    const state = createGnssState();
    feedFrame(state, sim.next());
    expect(state.fixQuality).toBe(1);
    expect(state.rmcActive).toBe(true);
    expect(state.gsaFixType).toBe(3);
    expect(state.satsInViewTotal).toBe(15);
    expect(state.satsUsedCount).toBe(15);
    expect(state.speedKmh).not.toBeNull();
    expect(state.speedKnots).not.toBeNull();
  });

  it("advances the UTC timestamp one second per frame", () => {
    const sim = new NmeaSimulator();
    const state = createGnssState();
    feedFrame(state, sim.next(new Date(Date.UTC(2024, 0, 1, 12, 0, 0))));
    feedFrame(state, sim.next(new Date(Date.UTC(2024, 0, 1, 12, 0, 1))));
    expect(state.utcTime?.toISOString()).toBe("2024-01-01T12:00:01.000Z");
  });

  it("start/stop control periodic emission", () => {
    vi.useFakeTimers();
    const sim = new NmeaSimulator({ intervalMs: 1000 });
    const cb = vi.fn();
    sim.start(cb);
    const initial = cb.mock.calls.length;
    expect(initial).toBeGreaterThan(0);
    vi.advanceTimersByTime(3500);
    const afterAdvance = cb.mock.calls.length;
    expect(afterAdvance).toBeGreaterThan(initial);
    sim.stop();
    const afterStop = cb.mock.calls.length;
    vi.advanceTimersByTime(10_000);
    expect(cb.mock.calls.length).toBe(afterStop);
  });
});