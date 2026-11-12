import type { SatelliteInfo } from "./types";

const RING_COLOR = "#1e2530";
const AXIS_COLOR = "#2a3344";
const LABEL_COLOR = "#5b6478";
const LABEL_BG = "#0a0d13";

function snrColor(snr: number | null): string {
  if (snr == null) return "#5b6478";
  if (snr >= 35) return "#34d399";
  if (snr >= 20) return "#22d3ee";
  return "#fbbf24";
}

export function drawSkyPlot(canvas: HTMLCanvasElement, sats: Map<string, SatelliteInfo>): void {
  const cssSize = Math.max(canvas.clientWidth || 280, 120);
  const dpr = Math.max(window.devicePixelRatio || 1, 1);
  const px = Math.round(cssSize * dpr);
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
    canvas.style.height = `${cssSize}px`;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);

  const cx = cssSize / 2;
  const cy = cssSize / 2;
  const R = cssSize / 2 - 16;

  ctx.strokeStyle = RING_COLOR;
  ctx.lineWidth = 1;
  for (const elev of [0, 30, 60]) {
    const r = R * (1 - elev / 90);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - R, cy);
  ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R);
  ctx.lineTo(cx, cy + R);
  ctx.strokeStyle = AXIS_COLOR;
  ctx.stroke();

  ctx.fillStyle = LABEL_COLOR;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("N", cx, cy - R - 8);
  ctx.fillText("S", cx, cy + R + 8);
  ctx.fillText("E", cx + R + 8, cy);
  ctx.fillText("W", cx - R - 8, cy);

  for (const sat of sats.values()) {
    if (sat.azimuth == null || sat.elevation == null) continue;
    const r = R * (1 - sat.elevation / 90);
    const a = (sat.azimuth * Math.PI) / 180;
    const x = cx + r * Math.sin(a);
    const y = cy - r * Math.cos(a);
    const color = snrColor(sat.snr);

    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    if (sat.used) {
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = LABEL_BG;
      ctx.font = "bold 7px ui-monospace, monospace";
      ctx.fillText(sat.prn, x, y + 0.5);
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}