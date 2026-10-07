import { emitLines } from "./serial";
import type { DeviceInfo, LineHandler } from "./serial";

const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
const FFE0_SERVICE = "0000ffe0-0000-1000-8000-00805f9b34fb";
const FFE0_CHAR = "0000ffe1-0000-1000-8000-00805f9b34fb";

interface BleUartProfile {
  service: string;
  rx: string;
  label: string;
}

const UART_PROFILES: BleUartProfile[] = [
  { service: NUS_SERVICE, rx: NUS_RX, label: "Nordic UART" },
  { service: FFE0_SERVICE, rx: FFE0_CHAR, label: "HM-10 (FFE0)" },
];

export class BluetoothLeLink {
  private device: BluetoothDevice | null = null;
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private valueHandler: ((event: Event) => void) | null = null;
  private disconnectHandler: (() => void) | null = null;
  private running = false;
  private decoder = new TextDecoder();
  private buffer = "";

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "bluetooth" in navigator;
  }

  get isOpen(): boolean {
    return this.device?.gatt?.connected === true;
  }

  getDeviceInfo(): DeviceInfo | null {
    return this.device ? { kind: "ble", name: this.device.name ?? undefined } : null;
  }

  async connect(onLine: LineHandler, onClosed: (error?: unknown) => void): Promise<void> {
    if (this.isOpen) await this.disconnect();
    const device = await navigator.bluetooth.requestDevice({
      filters: UART_PROFILES.map((p) => ({ services: [p.service] })),
      optionalServices: UART_PROFILES.map((p) => p.service),
    });
    this.device = device;
    this.running = true;
    this.disconnectHandler = () => {
      if (!this.running) return;
      this.running = false;
      onClosed();
    };
    device.addEventListener("gattserverdisconnected", this.disconnectHandler);
    try {
      const gatt = device.gatt;
      if (!gatt) throw new Error("device has no GATT server.");
      const server = await gatt.connect();
      let characteristic: BluetoothRemoteGATTCharacteristic | null = null;
      let found: string | null = null;
      for (const profile of UART_PROFILES) {
        try {
          const service = await server.getPrimaryService(profile.service);
          characteristic = await service.getCharacteristic(profile.rx);
          found = profile.label;
          break;
        } catch {
          /* try the next profile */
        }
      }
      if (!characteristic) {
        throw new Error("no BLE serial service found (tried Nordic UART and HM-10 FFE0).");
      }
      this.buffer = "";
      this.characteristic = characteristic;
      this.valueHandler = (event: Event) => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        this.buffer += this.decoder.decode(value, { stream: true });
        if (this.buffer.length > 65536) this.buffer = this.buffer.slice(-32768);
        this.buffer = emitLines(this.buffer, onLine);
      };
      characteristic.addEventListener("characteristicvaluechanged", this.valueHandler);
      await characteristic.startNotifications();
      if (!this.running) {
        throw new Error(`disconnected while opening ${found}.`);
      }
    } catch (err) {
      await this.disconnect();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.running = false;
    const characteristic = this.characteristic;
    this.characteristic = null;
    const valueHandler = this.valueHandler;
    this.valueHandler = null;
    const disconnectHandler = this.disconnectHandler;
    this.disconnectHandler = null;
    if (characteristic) {
      if (valueHandler) characteristic.removeEventListener("characteristicvaluechanged", valueHandler);
      try {
        await characteristic.stopNotifications();
      } catch {
        /* device may already be gone */
      }
    }
    if (this.device && disconnectHandler) {
      this.device.removeEventListener("gattserverdisconnected", disconnectHandler);
    }
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* device may already be gone */
    }
    this.device = null;
    this.buffer = "";
  }
}