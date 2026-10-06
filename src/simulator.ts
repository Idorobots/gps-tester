import { makeSentence } from "./nmea";

export interface SimSat {
  prn: string;
  el: number;
  az: number;
  snr: number | null;
}

const GP_SATS: SimSat[] = [
  { prn: "05", el: 32, az: 275, snr: 41 },
  { prn: "13", el: 71, az: 77, snr: 46 },
  { prn: "15", el: 18, az: 163, snr: 27 },
  { prn: "23", el: 44, az: 220, snr: 43 },
  { prn: "28", el: 8, az: 55, snr: null },
  { prn: "29", el: 63, az: 306, snr: 44 },
  { prn: "07", el: 25, az: 100, snr: 33 },
  { prn: "30", el: 55, az: 195, snr: 45 },
];

const GL_SATS: SimSat[] = [
  { prn: "65", el: 45, az: 180, snr: 38 },
  { prn: "66", el: 20, az: 120, snr: 30 },
  { prn: "72", el: 60, az: 250, snr: 40 },
  { prn: "73", el: 10, az: 40, snr: 21 },
];

const GA_SATS: SimSat[] = [
  { prn: "307", el: 50, az: 210, snr: 42 },
  { prn: "308", el: 35, az: 90, snr: 36 },
  { prn: "311", el: 15, az: 300, snr: 25 },
];

export interface SimOptions {
  lat?: number;
  lon?: number;
  speedKmh?: number;
  courseDeg?: number;
  altitudeM?: number;
  intervalMs?: number;
}

const KM_PER_DEG_LAT = 111.32;

function fmtLat(lat: number): string {
  const hemi = lat >= 0 ? "N" : "S";
  const a = Math.abs(lat);
  const d = Math.floor(a);
  const m = (a - d) * 60;
  return `${String(d).padStart(2, "0")}${m.toFixed(4).padStart(7, "0")},${hemi}`;
}

function fmtLon(lon: number): string {
  const hemi = lon >= 0 ? "E" : "W";
  const a = Math.abs(lon);
  const d = Math.floor(a);
  const m = (a - d) * 60;
  return `${String(d).padStart(3, "0")}${m.toFixed(4).padStart(7, "0")},${hemi}`;
}

function gsvSentences(talker: string, sats: SimSat[]): string[] {
  const totalMsgs = Math.ceil(sats.length / 4);
  const out: string[] = [];
  for (let i = 0; i < totalMsgs; i++) {
    const chunk = sats.slice(i * 4, i * 4 + 4);
    const fields = [talker + "GSV", String(totalMsgs), String(i + 1), String(sats.length)];
    for (const s of chunk) {
      fields.push(s.prn, String(s.el), String(s.az), s.snr == null ? "" : String(s.snr));
    }
    out.push(makeSentence(fields.join(",")));
  }
  return out;
}

function gsaSentence(talker: string, prns: string[], pdop: string, hdop: string, vdop: string): string {
  const slots = [...prns];
  while (slots.length < 12) slots.push("");
  const fields = [talker + "GSA", "A", "3", ...slots, pdop, hdop, vdop];
  return makeSentence(fields.join(","));
}

export class NmeaSimulator {
  private lat: number;
  private lon: number;
  private speedKmh: number;
  private courseDeg: number;
  private altitudeM: number;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SimOptions = {}) {
    this.lat = opts.lat ?? 48.1173;
    this.lon = opts.lon ?? 11.516667;
    this.speedKmh = opts.speedKmh ?? 42;
    this.courseDeg = opts.courseDeg ?? 63;
    this.altitudeM = opts.altitudeM ?? 519.5;
    this.intervalMs = opts.intervalMs ?? 1000;
  }

  next(now: Date = new Date()): string[] {
    const kmPerSec = this.speedKmh / 3600;
    const rad = (this.courseDeg * Math.PI) / 180;
    this.lat += (kmPerSec * Math.cos(rad)) / KM_PER_DEG_LAT;
    const lonScale = KM_PER_DEG_LAT * Math.cos((this.lat * Math.PI) / 180);
    if (Math.abs(lonScale) > 0.001) this.lon += (kmPerSec * Math.sin(rad)) / lonScale;

    const p2 = (n: number) => String(n).padStart(2, "0");
    const time = `${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}.00`;
    const date = `${p2(now.getUTCDate())}${p2(now.getUTCMonth() + 1)}${String(now.getUTCFullYear() % 100).padStart(2, "0")}`;
    const latStr = fmtLat(this.lat);
    const lonStr = fmtLon(this.lon);
    const knots = this.speedKmh / 1.852;
    const used = GP_SATS.length + GL_SATS.length + GA_SATS.length;

    const gsa = gsaSentence("GP", GP_SATS.map((s) => s.prn), "1.6", "0.9", "1.3");

    return [
      makeSentence(`GPRMC,${time},A,${latStr},${lonStr},${knots.toFixed(2)},${this.courseDeg.toFixed(1)},${date},,A`),
      makeSentence(`GPGGA,${time},${latStr},${lonStr},1,${used},0.9,${this.altitudeM.toFixed(1)},M,47.0,M,,`),
      gsa,
      ...gsvSentences("GP", GP_SATS),
      ...gsvSentences("GL", GL_SATS),
      ...gsvSentences("GA", GA_SATS),
      makeSentence(`GPVTG,${this.courseDeg.toFixed(1)},T,${(this.courseDeg - 4).toFixed(1)},M,${knots.toFixed(2)},N,${this.speedKmh.toFixed(2)},K,A`),
    ];
  }

  start(onSentence: (line: string) => void): void {
    this.stop();
    for (const line of this.next()) onSentence(line);
    this.timer = setInterval(() => {
      for (const line of this.next()) onSentence(line);
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }
}