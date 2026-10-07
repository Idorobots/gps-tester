import { describe, expect, it } from "vitest";
import { extractSentences, type SentenceExtraction } from "../src/serial";
import { applyLine, createGnssState, makeSentence } from "../src/nmea";

const GGA = makeSentence("GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,");
const RMC = makeSentence("GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W,A");

function feed(chunks: string[]): { sentences: string[]; garbage: number } {
  const sentences: string[] = [];
  let garbage = 0;
  let buffer = "";
  for (const chunk of chunks) {
    buffer += chunk;
    const result: SentenceExtraction = extractSentences(buffer);
    buffer = result.rest;
    sentences.push(...result.sentences);
    garbage += result.garbage;
  }
  return { sentences, garbage };
}

describe("extractSentences", () => {
  it("extracts CRLF-separated sentences in one pass", () => {
    const result = feed([`${GGA}\r\n${RMC}\r\n`]);
    expect(result.sentences).toEqual([GGA, RMC]);
    expect(result.garbage).toBe(0);
  });

  it("reassembles sentences split across chunk boundaries", () => {
    const result = feed([GGA.slice(0, 10), GGA.slice(10, 25), GGA.slice(25) + "\r\n"]);
    expect(result.sentences).toEqual([GGA]);
    expect(result.garbage).toBe(0);
  });

  it("counts leading garbage but keeps the following sentence", () => {
    const result = feed([`junk noise\r\n${GGA}\r\n`]);
    expect(result.sentences).toEqual([GGA]);
    expect(result.garbage).toBe(12);
  });

  it("resyncs at an embedded sentence start after an interrupted one", () => {
    const truncated = "$GPGGA,123519,48";
    const result = feed([truncated + RMC + "\r\n"]);
    expect(result.sentences).toEqual([RMC]);
    expect(result.garbage).toBe(truncated.length - 1);
  });

  it("recovers when a lost terminator glues a fragment onto a valid sentence", () => {
    const fragment = GGA.slice(0, GGA.length - 5);
    const result = feed([fragment + RMC + "\r\n"]);
    expect(result.sentences).toEqual([RMC]);
    expect(result.garbage).toBeGreaterThan(0);
  });

  it("drops sentences with corrupted checksums and keeps the next one", () => {
    const bad = GGA.slice(0, -1) + (GGA.endsWith("7") ? "8" : "7");
    const result = feed([`${bad}\r\n${RMC}\r\n`]);
    expect(result.sentences).toEqual([RMC]);
    expect(result.garbage).toBeGreaterThan(0);
  });

  it("accepts sentences glued together without any terminator", () => {
    const result = feed([GGA + RMC]);
    expect(result.sentences).toEqual([GGA, RMC]);
    expect(result.garbage).toBe(0);
  });

  it("keeps an incomplete tail in the buffer", () => {
    const result = extractSentences(`${GGA}\r\n$GPR`);
    expect(result.sentences).toEqual([GGA]);
    expect(result.rest).toBe("$GPR");
    expect(result.garbage).toBe(0);
  });

  it("waits for the checksum to complete", () => {
    const partial = "$GPRMC,123519,A*4";
    const result = extractSentences(partial);
    expect(result.sentences).toEqual([]);
    expect(result.rest).toBe(partial);
  });

  it("counts terminator-only input as garbage", () => {
    const result = extractSentences("\r\n\r\n");
    expect(result.sentences).toEqual([]);
    expect(result.garbage).toBe(4);
    expect(result.rest).toBe("");
  });

  it("parses recovered sentences through the NMEA parser", () => {
    const state = createGnssState();
    for (const sentence of feed(["junk\x01\x02" + GGA + RMC + "\r\n"]).sentences) {
      applyLine(state, sentence);
    }
    expect(state.messageCount).toBe(2);
    expect(state.errorCount).toBe(0);
    expect(state.lat).toBeCloseTo(48.1173, 6);
  });
});