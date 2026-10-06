import { describe, expect, it } from "vitest";
import {
  applyLine,
  createGnssState,
  makeSentence,
  nmeaChecksum,
  parseCoordinate,
  parseSentence,
  type GnssState,
} from "../src/nmea";

function feed(state: GnssState, lines: string[]): void {
  for (const line of lines) applyLine(state, line);
}

describe("checksum", () => {
  it("computes the documented checksum for a canonical GGA sentence", () => {
    const body = "GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,";
    expect(nmeaChecksum(body)).toBe("47");
  });

  it("makeSentence produces self-consistent checksums", () => {
    const body = "GPRMC,081836,A,3751.65,S,14530.01,E,000.0,360.0,130998,011.3,E";
    const sentence = makeSentence(body);
    expect(parseSentence(sentence)).not.toBeNull();
    expect(parseSentence(sentence)!.fields).toEqual(body.split(","));
  });

  it("rejects a corrupted checksum", () => {
    const good = makeSentence("GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,");
    const bad = good.slice(0, -1) + (good.endsWith("7") ? "8" : "7");
    expect(parseSentence(bad)).toBeNull();
  });

  it("rejects sentences without a checksum", () => {
    expect(parseSentence("$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,")).toBeNull();
  });

  it("rejects non-NMEA input", () => {
    expect(parseSentence("hello world")).toBeNull();
    expect(parseSentence("")).toBeNull();
  });
});

describe("parseCoordinate", () => {
  it("converts ddmm.mmmm with hemisphere", () => {
    expect(parseCoordinate("4807.038", "N")).toBeCloseTo(48.1173, 6);
    expect(parseCoordinate("01131.000", "E")).toBeCloseTo(11.5166667, 6);
  });

  it("negates for S and W", () => {
    expect(parseCoordinate("3751.65", "S")).toBeCloseTo(-37.8608333, 6);
    expect(parseCoordinate("14530.01", "W")).toBeCloseTo(-145.5001667, 6);
  });

  it("returns null for empty or malformed values", () => {
    expect(parseCoordinate("", "N")).toBeNull();
    expect(parseCoordinate("abc", "N")).toBeNull();
  });
});

describe("GGA", () => {
  it("parses position, fix quality, satellites, HDOP and altitude", () => {
    const state = createGnssState();
    feed(state, [makeSentence("GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,")]);
    expect(state.lat).toBeCloseTo(48.1173, 6);
    expect(state.lon).toBeCloseTo(11.5166667, 6);
    expect(state.fixQuality).toBe(1);
    expect(state.satsUsedCount).toBe(8);
    expect(state.hdop).toBeCloseTo(0.9, 6);
    expect(state.altitudeM).toBeCloseTo(545.4, 6);
    expect(state.utcTime?.getUTCHours()).toBe(12);
    expect(state.utcTime?.getUTCMinutes()).toBe(35);
    expect(state.utcTime?.getUTCSeconds()).toBe(19);
    expect(state.messageCount).toBe(1);
    expect(state.lastSentenceType).toBe("GPGGA");
    expect(state.talkersSeen.has("GP")).toBe(true);
  });

  it("treats quality 0 as no fix", () => {
    const state = createGnssState();
    feed(state, [makeSentence("GPGGA,123519,4807.038,N,01131.000,E,0,00,,,M,,M,,")]);
    expect(state.fixQuality).toBe(0);
    expect(state.satsUsedCount).toBe(0);
  });
});

describe("RMC", () => {
  it("parses status, speed, course and UTC date/time", () => {
    const state = createGnssState();
    feed(state, [makeSentence("GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W,A")]);
    expect(state.rmcActive).toBe(true);
    expect(state.speedKnots).toBeCloseTo(22.4, 6);
    expect(state.courseDeg).toBeCloseTo(84.4, 6);
    expect(state.utcTime?.toISOString()).toBe("1994-03-23T12:35:19.000Z");
  });

  it("marks void status", () => {
    const state = createGnssState();
    feed(state, [makeSentence("GPRMC,123519,V,4807.038,N,01131.000,E,,,230394,,")]);
    expect(state.rmcActive).toBe(false);
    expect(state.speedKnots).toBeNull();
  });
});

describe("VTG", () => {
  it("parses course and both speed units", () => {
    const state = createGnssState();
    feed(state, [makeSentence("GPVTG,054.7,T,034.4,M,005.5,N,010.2,K,A")]);
    expect(state.courseDeg).toBeCloseTo(54.7, 6);
    expect(state.speedKnots).toBeCloseTo(5.5, 6);
    expect(state.speedKmh).toBeCloseTo(10.2, 6);
  });
});

describe("GSV", () => {
  it("accumulates satellites across message groups and constellations", () => {
    const state = createGnssState();
    feed(state, [
      makeSentence("GPGSV,2,1,07,07,79,048,40,24,29,070,42,16,28,260,43,36,24,081,40"),
      makeSentence("GPGSV,2,2,07,21,09,173,39"),
      makeSentence("GLGSV,1,1,04,65,45,180,38,66,20,120,30,72,60,250,40,73,10,040,21"),
    ]);
    expect(state.satsInViewTotal).toBe(11);
    expect(state.sats.size).toBe(9);
    expect(state.sats.get("GP07")).toMatchObject({ elevation: 79, azimuth: 48, snr: 40, talker: "GP" });
    expect(state.sats.get("GL65")).toMatchObject({ elevation: 45, azimuth: 180, snr: 38, talker: "GL" });
  });

  it("handles missing SNR (untracked satellite)", () => {
    const state = createGnssState();
    feed(state, [makeSentence("GPGSV,1,1,04,36,24,081,40,21,09,173,,07,79,048,40,24,29,070,42")]);
    expect(state.sats.get("GP21")?.snr).toBeNull();
  });

  it("drops satellites that disappear on a new update cycle", () => {
    const state = createGnssState();
    feed(state, [
      makeSentence("GPGSV,1,1,04,07,79,048,40,24,29,070,42,16,28,260,43,36,24,081,40"),
      makeSentence("GPGSV,1,1,01,07,79,048,40"),
    ]);
    expect(state.sats.size).toBe(1);
    expect(state.sats.has("GP07")).toBe(true);
    expect(state.satsInViewTotal).toBe(1);
  });
});

describe("GSA", () => {
  it("parses fix dimension, HDOP and used satellite list", () => {
    const state = createGnssState();
    feed(state, [makeSentence("GPGSA,A,3,04,05,,09,12,,,24,,,,,2.5,1.3,2.1")]);
    expect(state.gsaFixType).toBe(3);
    expect(state.hdop).toBeCloseTo(1.3, 6);
    for (const prn of ["04", "05", "09", "12", "24"]) {
      expect(state.usedKeys.has("GP" + prn)).toBe(true);
    }
  });

  it("marks an existing satellite as used", () => {
    const state = createGnssState();
    feed(state, [
      makeSentence("GPGSV,1,1,01,04,79,048,40"),
      makeSentence("GPGSA,A,3,04,,,,,,,,,,,2.5,1.3,2.1"),
      makeSentence("GPGSV,1,1,01,04,79,048,40"),
    ]);
    expect(state.sats.get("GP04")?.used).toBe(true);
  });
});

describe("applyLine error accounting", () => {
  it("counts unparseable lines as errors", () => {
    const state = createGnssState();
    feed(state, ["garbage noise", "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47"]);
    expect(state.errorCount).toBe(1);
    expect(state.messageCount).toBe(1);
  });
});

describe("full frame integration", () => {
  it("derives a coherent lock state from one typical u-blox frame", () => {
    const state = createGnssState();
    feed(state, [
      makeSentence("GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W,A"),
      makeSentence("GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,"),
      makeSentence("GPGSA,A,3,04,05,,09,12,,,24,,,,,2.5,1.3,2.1"),
      makeSentence("GPGSV,2,1,07,07,79,048,40,24,29,070,42,16,28,260,43,36,24,081,40"),
      makeSentence("GPGSV,2,2,07,21,09,173,39"),
      makeSentence("GLGSV,1,1,04,65,45,180,38,66,20,120,30,72,60,250,40,73,10,040,21"),
      makeSentence("GPVTG,084.4,T,080.4,M,022.4,N,041.5,K,A"),
    ]);
    expect(state.messageCount).toBe(7);
    expect(state.fixQuality).toBe(1);
    expect(state.rmcActive).toBe(true);
    expect(state.gsaFixType).toBe(3);
    expect(state.lat).toBeCloseTo(48.1173, 6);
    expect(state.lon).toBeCloseTo(11.5166667, 6);
    expect(state.speedKmh).toBeCloseTo(41.5, 6);
    expect(state.courseDeg).toBeCloseTo(84.4, 6);
    expect(state.satsInViewTotal).toBe(11);
    expect(state.sats.get("GP24")?.used).toBe(true);
  });
});