import { describe, expect, it } from "vitest";
import { emitLines } from "../src/serial";

function collect(chunks: string[]): { lines: string[]; leftover: string } {
  const lines: string[] = [];
  let buffer = "";
  for (const chunk of chunks) {
    buffer = emitLines(buffer + chunk, (line) => lines.push(line));
  }
  return { lines, leftover: buffer };
}

describe("emitLines", () => {
  it("splits CRLF-terminated lines", () => {
    const { lines, leftover } = collect(["$GPGGA,1\r\n$GPRMC,2\r\n"]);
    expect(lines).toEqual(["$GPGGA,1", "$GPRMC,2"]);
    expect(leftover).toBe("");
  });

  it("reassembles lines split across chunk boundaries", () => {
    const { lines } = collect(["$GP", "GGA,123", "519,4807", ".038,N*40\r\n$GLGSV,1\r"]);
    expect(lines).toEqual(["$GPGGA,123519,4807.038,N*40", "$GLGSV,1"]);
  });

  it("keeps a trailing partial line in the buffer", () => {
    const first = collect(["$GPGGA,1\r\n$GPRMC,2"]);
    expect(first.lines).toEqual(["$GPGGA,1"]);
    expect(first.leftover).toBe("$GPRMC,2");
    const rest = emitLines(first.leftover + "3\r\n", (line) => first.lines.push(line));
    expect(first.lines).toEqual(["$GPGGA,1", "$GPRMC,23"]);
    expect(rest).toBe("");
  });

  it("treats bare CR and bare LF as terminators", () => {
    const { lines } = collect(["$A\r$B\n$C\r\n$D"]);
    expect(lines).toEqual(["$A", "$B", "$C"]);
  });

  it("passes non-NMEA lines through for diagnostics", () => {
    const { lines } = collect(["garbage noise\n"]);
    expect(lines).toEqual(["garbage noise"]);
  });

  it("drops empty lines", () => {
    const { lines } = collect(["\r\n\r\n$X\r\n"]);
    expect(lines).toEqual(["$X"]);
  });
});