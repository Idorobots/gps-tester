import { nmeaChecksum } from "./nmea";
import { retry } from "./retry";

export const BAUD_RATES = [4800, 9600, 19200, 38400, 57600, 115200, 230400] as const;

export type LineHandler = (line: string) => void;

export interface DeviceInfo {
  kind: "serial" | "ble";
  vendorId?: number;
  productId?: number;
  name?: string;
}

export interface UsbDeviceDescriptor {
  vendorId: number;
  name: string;
}

export const USB_SERIAL_DEVICES: readonly UsbDeviceDescriptor[] = [
  { vendorId: 0x1546, name: "u-blox" },
  { vendorId: 0x10c4, name: "Silicon Labs" },
  { vendorId: 0x0403, name: "FTDI" },
  { vendorId: 0x1a86, name: "WCH" },
  { vendorId: 0x067b, name: "Prolific" },
  { vendorId: 0x2341, name: "Arduino" },
  { vendorId: 0x2e8a, name: "Raspberry Pi" },
  { vendorId: 0x303a, name: "Espressif" },
  { vendorId: 0x1b4f, name: "SparkFun" },
  { vendorId: 0x239a, name: "Adafruit" },
  { vendorId: 0x0483, name: "STMicroelectronics" },
  { vendorId: 0x1fc9, name: "NXP" },
  { vendorId: 0x0d28, name: "ARM mbed" },
];

const USB_SERIAL_FILTERS = USB_SERIAL_DEVICES.map((d) => ({ usbVendorId: d.vendorId }));

export const SPP_SERVICE_UUID = "00001101-0000-1000-8000-00805f9b34fb";

const PORT_FILTERS: SerialPortFilter[] = [
  ...USB_SERIAL_FILTERS,
  { bluetoothServiceClassId: SPP_SERVICE_UUID },
];

export interface SentenceExtraction {
  sentences: string[];
  garbage: number;
  rest: string;
}

const CHECKSUM_RE = /^[0-9A-Fa-f]{2}$/;

export function extractSentences(buffer: string): SentenceExtraction {
  const sentences: string[] = [];
  let garbage = 0;
  let pos = 0;
  for (;;) {
    const start = buffer.indexOf("$", pos);
    if (start < 0) {
      garbage += buffer.length - pos;
      return { sentences, garbage, rest: "" };
    }
    garbage += start - pos;
    const star = buffer.indexOf("*", start + 1);
    if (star < 0) {
      return { sentences, garbage, rest: buffer.slice(start) };
    }
    const body = buffer.slice(start + 1, star);
    const nested = body.indexOf("$");
    if (nested >= 0) {
      garbage += nested;
      pos = start + 1 + nested;
      continue;
    }
    const cs = buffer.slice(star + 1, star + 3);
    if (cs.length < 2) {
      return { sentences, garbage, rest: buffer.slice(start) };
    }
    if (!CHECKSUM_RE.test(cs) || nmeaChecksum(body) !== cs.toUpperCase()) {
      garbage += star + 1 - start;
      pos = star + 1;
      continue;
    }
    const end = star + 3;
    let cursor = end;
    while (cursor < buffer.length && (buffer[cursor] === "\r" || buffer[cursor] === "\n")) cursor++;
    sentences.push(buffer.slice(start, end));
    pos = cursor;
  }
}

function sameUsbIdentity(a: SerialPort | null, b: SerialPort | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const ia = a.getInfo();
    const ib = b.getInfo();
    return (
      ia.usbVendorId !== undefined &&
      ia.usbVendorId === ib.usbVendorId &&
      ia.usbProductId === ib.usbProductId
    );
  } catch {
    return false;
  }
}

export class SerialGpsLink {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private loop: Promise<void> | null = null;
  private running = false;
  private open = false;
  private resuming = false;
  private baudRate = 9600;
  private onLine: LineHandler | null = null;
  private onClosedCb: ((error?: unknown) => void) | null = null;
  private onReconnectedCb: (() => void) | null = null;
  private onGarbageCb: ((chars: number) => void) | null = null;

  constructor() {
    if (SerialGpsLink.isSupported()) {
      navigator.serial.addEventListener("connect", (event) => {
        this.handlePortAppeared(event.target as SerialPort);
      });
    }
  }

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  get isOpen(): boolean {
    return this.open;
  }

  get isActive(): boolean {
    return this.running;
  }

  getDeviceInfo(): DeviceInfo | null {
    if (!this.port) return null;
    try {
      const info = this.port.getInfo();
      return { kind: "serial", vendorId: info.usbVendorId, productId: info.usbProductId };
    } catch {
      return null;
    }
  }

  async connect(
    baudRate: number,
    onLine: LineHandler,
    onClosed: (error?: unknown) => void,
    onReconnected?: () => void,
    onGarbage?: (chars: number) => void,
  ): Promise<void> {
    if (this.isOpen || this.running) await this.disconnect();
    const port = await navigator.serial.requestPort({ filters: PORT_FILTERS });
    await port.open({ baudRate });
    this.baudRate = baudRate;
    this.onLine = onLine;
    this.onClosedCb = onClosed;
    this.onReconnectedCb = onReconnected ?? null;
    this.onGarbageCb = onGarbage ?? null;
    this.port = port;
    this.running = true;
    this.open = true;
    this.loop = this.readLoop(port);
  }

  private async readLoop(port: SerialPort): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (this.running && port.readable) {
        const reader = port.readable.getReader();
        this.reader = reader;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > 65536) buffer = buffer.slice(-32768);
            const result = extractSentences(buffer);
            buffer = result.rest;
            for (const sentence of result.sentences) this.onLine?.(sentence);
            if (result.garbage > 0) this.onGarbageCb?.(result.garbage);
          }
        } finally {
          this.reader = null;
          reader.releaseLock();
        }
        if (!this.running) return;
      }
      if (this.running) void this.handleUnexpectedClose();
    } catch (err) {
      if (this.running) void this.handleUnexpectedClose(err);
    }
  }

  private async handleUnexpectedClose(error?: unknown): Promise<void> {
    this.open = false;
    this.onClosedCb?.(error);
    if (!this.running || !this.port) return;
    await this.tryResume();
  }

  private async tryResume(): Promise<void> {
    if (this.resuming) return;
    this.resuming = true;
    try {
      const port = this.port;
      if (!port || !this.running) return;
      const reopened = await retry(3, async () => {
        if (!this.running) throw new Error("aborted");
        try {
          await port.close();
        } catch {
          /* device may be gone or not open */
        }
        await port.open({ baudRate: this.baudRate });
      })
        .then(() => true)
        .catch(() => false);
      if (!reopened || !this.running || this.port !== port) return;
      this.open = true;
      this.onReconnectedCb?.();
      this.loop = this.readLoop(port);
    } finally {
      this.resuming = false;
    }
  }

  private handlePortAppeared(candidate: SerialPort): void {
    if (!this.running || this.open || this.resuming) return;
    if (!sameUsbIdentity(candidate, this.port)) return;
    this.port = candidate;
    void this.tryResume();
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.open = false;
    try {
      await this.reader?.cancel();
    } catch {
      /* device may already be gone */
    }
    await this.loop?.catch(() => {});
    try {
      await this.port?.close();
    } catch {
      /* device may already be gone */
    }
    this.reader = null;
    this.port = null;
    this.loop = null;
  }
}