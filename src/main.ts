import "./style.css";
import { BAUD_RATES, SerialGpsLink, USB_SERIAL_DEVICES } from "./serial";
import type { DeviceInfo } from "./serial";
import { applyLine, createGnssState } from "./nmea";
import type { GnssState } from "./types";
import { drawSkyPlot } from "./skyplot";
import { createGpsMap } from "./map";
import { NmeaSimulator } from "./simulator";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const baudSelect = $<HTMLSelectElement>("baud");
const connectBtn = $<HTMLButtonElement>("connectBtn");
const simBtn = $<HTMLButtonElement>("simBtn");
const deviceName = $("deviceName");
const rawCard = $("rawCard");
const rawToggle = $<HTMLButtonElement>("rawToggle");
const badge = $("connBadge");
const connText = $("connText");
const actDot = $("actDot");
const banner = $("banner");
const trafficEl = $("traffic");
const fixLabel = $("fixLabel");
const fixDetail = $("fixDetail");
const latEl = $("lat");
const lonEl = $("lon");
const altEl = $("alt");
const hdopEl = $("hdop");
const speedEl = $("speed");
const knotsEl = $("knots");
const courseEl = $("course");
const satCounts = $("satCounts");
const skyCanvas = $<HTMLCanvasElement>("skyplot");
const feedTime = $("feedTime");
const feedLast = $("feedLast");
const feedCount = $("feedCount");
const feedErrors = $("feedErrors");
const rawLog = $<HTMLPreElement>("rawLog");
const mapEl = $("map");
const followBox = $<HTMLInputElement>("follow");

for (const b of BAUD_RATES) {
  const opt = document.createElement("option");
  opt.value = String(b);
  opt.textContent = String(b);
  if (b === 9600) opt.selected = true;
  baudSelect.append(opt);
}

if (!SerialGpsLink.isSupported()) {
  banner.hidden = false;
  banner.textContent =
    "Web Serial is not available in this browser. Use a Chromium-based browser (Chrome, Edge, Opera) over HTTPS or localhost.";
  connectBtn.disabled = true;
}

let state: GnssState = createGnssState();
let rawLines: string[] = [];
let noiseCount = 0;
let lastLineMs: number | null = null;
let msgRate = 0;
let lastRateCount = 0;
const link = new SerialGpsLink();
const sim = new NmeaSimulator();
let simRunning = false;
let rawOpen = false;

function vendorName(vid: number): string | undefined {
  return USB_SERIAL_DEVICES.find((d) => d.vendorId === vid)?.name;
}

function hex4(n: number | undefined): string {
  return n == null ? "????" : n.toString(16).toUpperCase().padStart(4, "0");
}

function describeDevice(info: DeviceInfo | null): string {
  if (!info || info.vendorId == null) return "Serial device";
  const vendor = vendorName(info.vendorId);
  const id = `${hex4(info.vendorId)}:${hex4(info.productId)}`;
  return vendor ? `${vendor} (${id})` : `USB ${id}`;
}

function setDeviceLabel(text: string | null): void {
  deviceName.hidden = text == null;
  deviceName.textContent = text ?? "";
}

const gpsMap = createGpsMap(mapEl, followBox);

function onLine(line: string): void {
  lastLineMs = Date.now();
  if (line.startsWith("$")) {
    applyLine(state, line);
  } else {
    noiseCount++;
  }
  rawLines.push(line.length > 160 ? line.slice(0, 160) + "…" : line);
  if (rawLines.length > 60) rawLines = rawLines.slice(-30);
  scheduleRender();
}

let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

const QUALITY_LABELS: Record<number, string> = {
  1: "GPS Fix",
  2: "DGPS Fix",
  3: "PPS Fix",
  4: "RTK Fix",
  5: "Float RTK",
  6: "Estimated",
  7: "Manual",
  8: "Simulation",
};

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

function compass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16] ?? "N";
}

function hdopLabel(h: number | null): string {
  if (h == null) return "";
  if (h <= 1) return "Excellent";
  if (h <= 2) return "Good";
  if (h <= 5) return "Moderate";
  if (h <= 10) return "Fair";
  return "Poor";
}

function num(v: number | null, digits: number, suffix = ""): string {
  return v == null ? "—" : `${v.toFixed(digits)}${suffix}`;
}

function render(): void {
  const q = state.fixQuality;
  const active = state.rmcActive;
  const hasFix = (q != null && q > 0) || active === true;
  const base = hasFix ? (q != null && q > 0 ? (QUALITY_LABELS[q] ?? "Fix") : "Fix") : "No Fix";
  const dim = state.gsaFixType === 2 ? " · 2D" : state.gsaFixType === 3 ? " · 3D" : "";
  fixLabel.textContent = base + dim;
  fixLabel.className = "fix-label " + (hasFix ? "fix" : "nofix");
  fixDetail.textContent = hasFix
    ? `Quality ${q ?? "?"} · HDOP ${num(state.hdop, 1)}${state.hdop != null ? ` (${hdopLabel(state.hdop)})` : ""}`
    : "Waiting for signal…";

  latEl.textContent = num(state.lat, 6, "°");
  lonEl.textContent = num(state.lon, 6, "°");
  altEl.textContent = num(state.altitudeM, 1, " m");
  hdopEl.textContent = num(state.hdop, 1);

  const knots = state.speedKnots;
  const kmh = state.speedKmh ?? (knots == null ? null : knots * 1.852);
  speedEl.textContent = num(kmh, 1, " km/h");
  knotsEl.textContent = num(knots, 1, " kn");
  courseEl.textContent = state.courseDeg == null ? "—" : `${state.courseDeg.toFixed(1)}° ${compass(state.courseDeg)}`;

  const used = state.satsUsedCount ?? [...state.sats.values()].filter((s) => s.used).length;
  satCounts.textContent = `${used} used · ${state.satsInViewTotal} in view`;

  feedTime.textContent = state.utcTime ? `${state.utcTime.toISOString().slice(11, 19)} UTC` : "—";
  feedLast.textContent = state.lastSentenceType ?? "—";
  feedCount.textContent = String(state.messageCount);
  feedErrors.textContent = String(state.errorCount);

  const connected = simRunning || link.isOpen;
  const ageMs = lastLineMs == null ? Infinity : Date.now() - lastLineMs;
  let trafficClass = "";
  let trafficText = "Idle";
  if (connected) {
    if (ageMs > 3000) {
      trafficText = "No data";
      trafficClass = "warn";
    } else if (state.messageCount === 0 && (noiseCount > 0 || state.errorCount > 0)) {
      trafficText = "Invalid data — check baud rate";
      trafficClass = "bad";
    } else {
      trafficText = msgRate > 0 ? `Streaming · ${msgRate} msg/s` : "Streaming";
      trafficClass = "ok";
    }
  }
  trafficEl.textContent = trafficText;
  trafficEl.className = trafficClass;
  actDot.classList.toggle("live", connected && ageMs < 800);

  drawSkyPlot(skyCanvas, state.sats);

  if (state.lat != null && state.lon != null) gpsMap.update(state.lat, state.lon, hasFix);

  if (rawOpen) {
    rawLog.hidden = false;
    rawLog.textContent = rawLines.slice(-40).join("\n");
    rawLog.scrollTop = rawLog.scrollHeight;
  } else {
    rawLog.hidden = true;
  }
}

function setBadge(mode: "off" | "on" | "sim", text: string): void {
  badge.className = "badge " + (mode === "off" ? "off" : mode === "on" ? "on" : "sim");
  connText.textContent = text;
}

function resetState(): void {
  state = createGnssState();
  rawLines = [];
  noiseCount = 0;
  lastLineMs = null;
  msgRate = 0;
  lastRateCount = 0;
  scheduleRender();
}

function errText(err: unknown): string {
  if (err instanceof DOMException && err.name === "NotFoundError") return "no serial port selected.";
  return String(err);
}

connectBtn.addEventListener("click", async () => {
  if (simRunning) toggleSim();
  if (link.isOpen) {
    await link.disconnect();
    setBadge("off", "Disconnected");
    setDeviceLabel(null);
    connectBtn.textContent = "Connect";
    return;
  }
  try {
    resetState();
    await link.connect(
      Number(baudSelect.value),
      onLine,
      async (err) => {
        await link.disconnect();
        setBadge("off", "Disconnected");
        setDeviceLabel(null);
        connectBtn.textContent = "Connect";
        if (err) {
          banner.hidden = false;
          banner.textContent = `Serial error: ${errText(err)}`;
        }
      },
    );
    setBadge("on", "Connected");
    setDeviceLabel(describeDevice(link.getDeviceInfo()));
    connectBtn.textContent = "Disconnect";
    banner.hidden = true;
  } catch (err) {
    setBadge("off", "Disconnected");
    setDeviceLabel(null);
    banner.hidden = false;
    banner.textContent = `Could not open serial port: ${errText(err)}`;
  }
});

simBtn.addEventListener("click", () => toggleSim());

rawToggle.addEventListener("click", () => {
  rawOpen = !rawOpen;
  rawCard.classList.toggle("open", rawOpen);
  scheduleRender();
});

function toggleSim(): void {
  if (simRunning) {
    sim.stop();
    simRunning = false;
    simBtn.textContent = "Simulate";
    setBadge("off", "Disconnected");
    setDeviceLabel(null);
    return;
  }
  if (link.isOpen) {
    void link.disconnect();
    connectBtn.textContent = "Connect";
    setDeviceLabel(null);
  }
  resetState();
  sim.start(onLine);
  simRunning = true;
  simBtn.textContent = "Stop Simulation";
  setBadge("sim", "Simulated");
  setDeviceLabel("Simulated GPS");
}

setBadge("off", "Disconnected");
render();

setInterval(() => {
  msgRate = state.messageCount - lastRateCount;
  lastRateCount = state.messageCount;
  scheduleRender();
}, 1000);