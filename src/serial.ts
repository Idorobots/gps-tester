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

export function emitLines(buffer: string, onLine: LineHandler): string {
  let idx: number;
  while ((idx = buffer.search(/\r|\n/)) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) onLine(line);
  }
  return buffer;
}

export class SerialGpsLink {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private loop: Promise<void> | null = null;
  private running = false;

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  get isOpen(): boolean {
    return this.port !== null;
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

  async connect(baudRate: number, onLine: LineHandler, onClosed: (error?: unknown) => void): Promise<void> {
    if (this.isOpen) await this.disconnect();
    const port = await navigator.serial.requestPort({ filters: PORT_FILTERS });
    await port.open({ baudRate });
    this.port = port;
    this.running = true;
    this.loop = this.readLoop(port, onLine, onClosed);
  }

  private async readLoop(port: SerialPort, onLine: LineHandler, onClosed: (error?: unknown) => void): Promise<void> {
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
            buffer = emitLines(buffer, onLine);
          }
        } finally {
          this.reader = null;
          reader.releaseLock();
        }
        if (!this.running) return;
      }
      if (this.running) onClosed();
    } catch (err) {
      if (this.running) onClosed(err);
    }
  }

  async disconnect(): Promise<void> {
    this.running = false;
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