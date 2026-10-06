import type { GnssState, SatelliteInfo } from "./types";
export type { GnssState, SatelliteInfo } from "./types";

export interface ParsedSentence {
  talker: string;
  type: string;
  fields: string[];
}

export function nmeaChecksum(body: string): string {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return c.toString(16).toUpperCase().padStart(2, "0");
}

export function makeSentence(body: string): string {
  return `$${body}*${nmeaChecksum(body)}`;
}

export function parseSentence(raw: string): ParsedSentence | null {
  const line = raw.trim();
  if (!line.startsWith("$")) return null;
  const star = line.indexOf("*");
  if (star < 0) return null;
  const body = line.slice(1, star);
  const provided = line.slice(star + 1);
  if (provided.length < 2) return null;
  if (nmeaChecksum(body) !== provided.slice(0, 2).toUpperCase()) return null;
  const fields = body.split(",");
  const addr = fields[0] ?? "";
  if (addr.length < 5) return null;
  return {
    talker: addr.slice(0, addr.length - 3),
    type: addr.slice(-3),
    fields,
  };
}

export function createGnssState(): GnssState {
  return {
    messageCount: 0,
    errorCount: 0,
    lastUpdateMs: null,
    lastSentenceType: null,
    talkersSeen: new Set(),
    utcTime: null,
    fixQuality: null,
    rmcActive: null,
    gsaFixType: null,
    lat: null,
    lon: null,
    altitudeM: null,
    hdop: null,
    speedKnots: null,
    speedKmh: null,
    courseDeg: null,
    satsUsedCount: null,
    satsInViewTotal: 0,
    satsInViewByTalker: new Map(),
    usedKeys: new Set(),
    sats: new Map(),
  };
}

export function parseCoordinate(value: string, hemisphere: string): number | null {
  if (!value) return null;
  const num = Number.parseFloat(value);
  if (!Number.isFinite(num)) return null;
  const deg = Math.floor(num / 100);
  const min = num - deg * 100;
  const result = deg + min / 60;
  if (hemisphere === "S" || hemisphere === "W") return -result;
  return result;
}

interface UtcClock {
  h: number;
  m: number;
  s: number;
  ms: number;
}

function parseUtcClock(value: string): UtcClock | null {
  const m = /^(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const frac = m[4] ?? "";
  const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  return { h: Number(m[1]), m: Number(m[2]), s: Number(m[3]), ms };
}

function combineUtc(clockValue: string, dateValue: string | null): Date | null {
  const c = parseUtcClock(clockValue);
  if (!c) return null;
  let y: number;
  let mo: number;
  let d: number;
  const now = new Date();
  y = now.getUTCFullYear();
  mo = now.getUTCMonth();
  d = now.getUTCDate();
  if (dateValue && dateValue.length === 6) {
    d = Number(dateValue.slice(0, 2));
    mo = Number(dateValue.slice(2, 4)) - 1;
    y = 2000 + Number(dateValue.slice(4, 6));
    if (y > now.getUTCFullYear() + 50) y -= 100;
  }
  const date = new Date(Date.UTC(y, mo, d, c.h, c.m, c.s, c.ms));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseIntOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloatOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function applyGGA(state: GnssState, f: string[]): void {
  const c = parseUtcClock(f[1] ?? "");
  if (c) {
    const base = state.utcTime ?? new Date();
    const date = new Date(
      Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), c.h, c.m, c.s, c.ms),
    );
    if (!Number.isNaN(date.getTime())) state.utcTime = date;
  }
  const lat = parseCoordinate(f[2] ?? "", f[3] ?? "");
  if (lat !== null) state.lat = lat;
  const lon = parseCoordinate(f[4] ?? "", f[5] ?? "");
  if (lon !== null) state.lon = lon;
  const q = parseIntOrNull(f[6]);
  if (q !== null && q >= 0) state.fixQuality = q;
  const used = parseIntOrNull(f[7]);
  if (used !== null) state.satsUsedCount = used;
  const hdop = parseFloatOrNull(f[8]);
  if (hdop !== null) state.hdop = hdop;
  const alt = parseFloatOrNull(f[9]);
  if (alt !== null) state.altitudeM = alt;
}

function applyRMC(state: GnssState, f: string[]): void {
  const status = (f[2] ?? "").toUpperCase();
  if (status === "A") state.rmcActive = true;
  else if (status === "V") state.rmcActive = false;
  const t = combineUtc(f[1] ?? "", f[9] ?? "");
  if (t) state.utcTime = t;
  const lat = parseCoordinate(f[3] ?? "", f[4] ?? "");
  if (lat !== null) state.lat = lat;
  const lon = parseCoordinate(f[5] ?? "", f[6] ?? "");
  if (lon !== null) state.lon = lon;
  const knots = parseFloatOrNull(f[7]);
  if (knots !== null) state.speedKnots = knots;
  const course = parseFloatOrNull(f[8]);
  if (course !== null) state.courseDeg = course;
}

function applyGSA(state: GnssState, f: string[], talker: string): void {
  const fix = parseIntOrNull(f[2]);
  if (fix !== null && fix >= 1 && fix <= 3) state.gsaFixType = fix;
  const hdop = parseFloatOrNull(f[16]);
  if (hdop !== null) state.hdop = hdop;
  for (let i = 3; i <= 14; i++) {
    const prn = (f[i] ?? "").trim();
    if (!prn) continue;
    const key = talker + prn;
    state.usedKeys.add(key);
    const sat = state.sats.get(key);
    if (sat) sat.used = true;
  }
}

function applyGSV(state: GnssState, f: string[], talker: string): void {
  const msgNum = parseIntOrNull(f[2]);
  const inView = parseIntOrNull(f[3]);
  if (inView !== null) {
    state.satsInViewByTalker.set(talker, inView);
    let total = 0;
    for (const v of state.satsInViewByTalker.values()) total += v;
    state.satsInViewTotal = total;
  }
  if (msgNum === 1) {
    for (const key of [...state.sats.keys()]) {
      if (state.sats.get(key)!.talker === talker) state.sats.delete(key);
    }
  }
  for (let g = 0; g < 4; g++) {
    const base = 4 + g * 4;
    const prn = (f[base] ?? "").trim();
    if (!prn) break;
    const key = talker + prn;
    const sat: SatelliteInfo = {
      key,
      talker,
      prn,
      elevation: parseFloatOrNull(f[base + 1]),
      azimuth: parseFloatOrNull(f[base + 2]),
      snr: parseFloatOrNull(f[base + 3]),
      used: state.usedKeys.has(key),
    };
    state.sats.set(key, sat);
  }
}

function applyVTG(state: GnssState, f: string[]): void {
  const course = parseFloatOrNull(f[1]);
  if (course !== null) state.courseDeg = course;
  const knots = parseFloatOrNull(f[5]);
  if (knots !== null) state.speedKnots = knots;
  const kmh = parseFloatOrNull(f[7]);
  if (kmh !== null) state.speedKmh = kmh;
}

export function applyLine(state: GnssState, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  const s = parseSentence(trimmed);
  if (!s) {
    state.errorCount++;
    return;
  }
  state.messageCount++;
  state.lastUpdateMs = Date.now();
  state.lastSentenceType = s.talker + s.type;
  state.talkersSeen.add(s.talker);
  switch (s.type) {
    case "GGA":
      applyGGA(state, s.fields);
      break;
    case "RMC":
      applyRMC(state, s.fields);
      break;
    case "GSA":
      applyGSA(state, s.fields, s.talker);
      break;
    case "GSV":
      applyGSV(state, s.fields, s.talker);
      break;
    case "VTG":
      applyVTG(state, s.fields);
      break;
  }
}