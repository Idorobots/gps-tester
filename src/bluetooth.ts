import { extractSentences } from "./serial";
import type { DeviceInfo, LineHandler } from "./serial";
import { retry, sleep } from "./retry";

const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const FFE0_SERVICE = "0000ffe0-0000-1000-8000-00805f9b34fb";

const BLE_RESUME_ATTEMPTS = 5;

const WATCHDOG_TICK_MS = 10_000;
const RESUBSCRIBE_AFTER_MS = 30_000;
const MAX_RESUBSCRIBES = 3;
const RESUBSCRIBE_GAP_MS = 250;

const DISCONNECT_STORM_WINDOW_MS = 10_000;
const DISCONNECT_STORM_LIMIT = 3;

export const BLE_RESUBSCRIBE_AFTER_MS = RESUBSCRIBE_AFTER_MS;

export function watchdogDue(
  now: number,
  lastDataMs: number | null,
  lastActionMs: number,
  resuming: boolean,
): boolean {
  if (resuming) return false;
  if (lastDataMs !== null && now - lastDataMs < RESUBSCRIBE_AFTER_MS) return false;
  return now - lastActionMs >= RESUBSCRIBE_AFTER_MS;
}

interface BleUartProfile {
  service: string;
  label: string;
}

const UART_PROFILES: BleUartProfile[] = [
  { service: NUS_SERVICE, label: "Nordic UART" },
  { service: FFE0_SERVICE, label: "HM-10 (FFE0)" },
];

function tag(msg: string): string {
  return `[BLE ${new Date().toISOString().slice(11, 23)}] ${msg}`;
}

function errText(err: unknown): string {
  if (err instanceof DOMException) return `${err.name}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

const logInfo = (msg: string, ...rest: unknown[]): void => console.info(tag(msg), ...rest);
const logDebug = (msg: string, ...rest: unknown[]): void => console.debug(tag(msg), ...rest);
const logWarn = (msg: string, ...rest: unknown[]): void => console.warn(tag(msg), ...rest);
const logError = (msg: string, ...rest: unknown[]): void => console.error(tag(msg), ...rest);

export interface BleLinkCallbacks {
  onLine: LineHandler;
  onClosed: (error?: unknown) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  onGarbage?: (chars: number) => void;
}

export class BluetoothLeLink {
  private device: BluetoothDevice | null = null;
  private notifyChars: BluetoothRemoteGATTCharacteristic[] = [];
  private txChar: BluetoothRemoteGATTCharacteristic | null = null;
  private valueHandler: ((event: Event) => void) | null = null;
  private disconnectHandler: (() => void) | null = null;
  private running = false;
  private resuming = false;
  private gattQueue: Promise<void> = Promise.resolve();
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private buffer = "";
  private callbacks: BleLinkCallbacks | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastDataMs: number | null = null;
  private lastWatchdogActionMs = 0;
  private resubscribeCount = 0;
  private attachMs = 0;
  private stormCount = 0;
  private firstDataLogged = false;

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "bluetooth" in navigator;
  }

  get isOpen(): boolean {
    return this.device?.gatt?.connected === true;
  }

  get isActive(): boolean {
    return this.running;
  }

  getDeviceInfo(): DeviceInfo | null {
    return this.device ? { kind: "ble", name: this.device.name ?? undefined } : null;
  }

  async connect(callbacks: BleLinkCallbacks): Promise<void> {
    if (this.isOpen || this.isActive) await this.disconnect();
    this.callbacks = callbacks;
    logInfo("connect: requesting device (filters: NUS / HM-10 FFE0)…");
    const device = await navigator.bluetooth.requestDevice({
      filters: UART_PROFILES.map((p) => ({ services: [p.service] })),
      optionalServices: UART_PROFILES.map((p) => p.service),
    });
    logInfo(`connect: selected ${JSON.stringify(device.name ?? "?")} id=${device.id}`);
    this.device = device;
    this.running = true;
    this.disconnectHandler = () => {
      if (!this.running) return;
      void this.handleUnexpectedDisconnect();
    };
    device.addEventListener("gattserverdisconnected", this.disconnectHandler);
    const started = performance.now();
    try {
      const gatt = device.gatt;
      if (!gatt) throw new Error("device has no GATT server.");
      logDebug("connect: opening GATT server…");
      const server = await gatt.connect();
      logInfo(`connect: GATT connected in ${Math.round(performance.now() - started)} ms`);
      this.buffer = "";
      this.valueHandler = (event: Event) => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        if (!this.firstDataLogged) {
          this.firstDataLogged = true;
          logInfo("link: first notification received");
        }
        this.lastDataMs = Date.now();
        this.resubscribeCount = 0;
        this.stormCount = 0;
        this.buffer += this.decoder.decode(value, { stream: true });
        if (this.buffer.length > 65536) this.buffer = this.buffer.slice(-32768);
        const result = extractSentences(this.buffer);
        this.buffer = result.rest;
        for (const sentence of result.sentences) callbacks.onLine(sentence);
        if (result.garbage > 0) callbacks.onGarbage?.(result.garbage);
      };
      await this.attach(server);
      if (!this.running) {
        throw new Error("disconnected while opening.");
      }
    } catch (err) {
      logError(`connect: failed — ${errText(err)}`);
      await this.disconnect();
      throw err;
    }
  }

  private async attach(server: BluetoothRemoteGATTServer): Promise<void> {
    const started = performance.now();
    this.decoder = new TextDecoder();
    this.buffer = "";
    this.notifyChars = [];
    this.txChar = null;
    for (const profile of UART_PROFILES) {
      try {
        logDebug(`attach: probing ${profile.label} service…`);
        const service = await server.getPrimaryService(profile.service);
        const characteristics = await service.getCharacteristics();
        logDebug(
          `attach: ${profile.label} exposes ${characteristics.length} characteristic(s):`,
          characteristics.map((c) => `${c.uuid} [${Object.keys(c.properties).filter((k) => (c.properties as unknown as Record<string, boolean>)[k]).join(",")}]`),
        );
        const notifyChars = characteristics.filter(
          (c) => c.properties.notify || c.properties.indicate,
        );
        if (notifyChars.length === 0) {
          logWarn(`attach: ${profile.label} has no notify/indicate characteristic`);
          continue;
        }
        this.txChar =
          characteristics.find(
            (c) => c.properties.write || c.properties.writeWithoutResponse,
          ) ?? null;
        const handler = this.valueHandler;
        if (!handler) throw new Error("link not initialized.");
        for (const c of notifyChars) {
          const mode = c.properties.notify ? (c.properties.indicate ? "notify+indicate" : "notify") : "indicate";
          c.addEventListener("characteristicvaluechanged", handler);
          await c.startNotifications();
          this.notifyChars.push(c);
          logDebug(`attach: subscribed to ${mode} on ${c.uuid}`);
        }
        logInfo(
          `attach: ${profile.label} active in ${Math.round(performance.now() - started)} ms — notifying on ${this.notifyChars.map((c) => `${c.uuid} (${c.properties.notify ? (c.properties.indicate ? "notify+indicate" : "notify") : "indicate"})`).join(", ")}, TX=${this.txChar?.uuid ?? "none"}`,
        );
        this.attachMs = Date.now();
        this.firstDataLogged = false;
        this.startWatchdog();
        return;
      } catch (err) {
        logWarn(`attach: ${profile.label} unavailable — ${errText(err)}`);
      }
    }
    throw new Error("no notify-capable characteristic found in Nordic UART or HM-10 FFE0 service.");
  }

  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.gattQueue.then(op, op);
    this.gattQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private handleUnexpectedDisconnect(): void {
    if (!this.device || !this.running || this.resuming) return;
    const gapMs = Date.now() - this.attachMs;
    this.stormCount = gapMs < DISCONNECT_STORM_WINDOW_MS ? this.stormCount + 1 : 1;
    logWarn(
      `link: unexpected GATT disconnect ${(gapMs / 1000).toFixed(1)}s after attach (storm ${this.stormCount}/${DISCONNECT_STORM_LIMIT})`,
    );
    if (this.stormCount >= DISCONNECT_STORM_LIMIT) {
      const err = new Error(
        "device repeatedly drops the connection right after subscription. Check its firmware/pairing requirements, or use SPP/USB instead.",
      );
      logError(`link: disconnect storm detected — giving up: ${errText(err)}`);
      this.running = false;
      this.callbacks?.onClosed?.(err);
      void this.exclusive(() => this.cleanup());
      return;
    }
    this.callbacks?.onReconnecting?.();
    void this.tryResume();
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.lastDataMs = Date.now();
    this.resubscribeCount = 0;
    this.watchdogTimer = setInterval(() => this.checkWatchdog(), WATCHDOG_TICK_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private checkWatchdog(): void {
    if (!this.running || !this.device?.gatt?.connected) return;
    const now = Date.now();
    if (!watchdogDue(now, this.lastDataMs, this.lastWatchdogActionMs, this.resuming)) return;
    this.lastWatchdogActionMs = now;
    logInfo(
      `watchdog: ${Math.round((now - (this.lastDataMs ?? this.lastWatchdogActionMs)) / 1000)}s without data — re-subscribing (attempt ${this.resubscribeCount + 1}/${MAX_RESUBSCRIBES})`,
    );
    void this.resubscribe();
  }

  private async resubscribe(): Promise<void> {
    await this.exclusive(async () => {
      if (!this.running) return;
      try {
        for (const c of [...this.notifyChars]) {
          await c.stopNotifications();
          await sleep(RESUBSCRIBE_GAP_MS);
          if (!this.running) return;
          await c.startNotifications();
          await sleep(RESUBSCRIBE_GAP_MS);
        }
        this.resubscribeCount++;
        logDebug("watchdog: re-subscribed to notifications");
        if (this.resubscribeCount >= MAX_RESUBSCRIBES) {
          this.resubscribeCount = 0;
          logWarn("watchdog: no data after max re-subscribes — forcing full reconnect");
          try {
            this.device?.gatt?.disconnect();
          } catch {
            /* device may already be gone */
          }
          void this.tryResume();
        }
      } catch (err) {
        logWarn(`watchdog: re-subscribe failed — ${errText(err)}`);
        void this.tryResume();
      }
    });
  }

  private async tryResume(): Promise<void> {
    if (this.resuming) return;
    this.resuming = true;
    try {
      await this.exclusive(async () => {
        const gatt = this.device?.gatt;
        if (!gatt || !this.running) return;
        const server = await retry(BLE_RESUME_ATTEMPTS, async (attempt) => {
          if (!this.running) throw new Error("aborted");
          logInfo(`resume: reconnect attempt ${attempt}/${BLE_RESUME_ATTEMPTS}…`);
          return await gatt.connect();
        }).catch((err: unknown) => {
          logWarn(`resume: exhausted ${BLE_RESUME_ATTEMPTS} attempts — ${errText(err)}`);
          return null;
        });
        if (!server || !this.running) {
          if (this.running) {
            logWarn("resume: giving up — link closed");
            this.running = false;
            this.callbacks?.onClosed?.();
            await this.cleanup();
          }
          return;
        }
        logInfo("resume: GATT reconnected");
        await this.attach(server);
        if (!this.running) return;
        this.callbacks?.onReconnected?.();
      });
    } catch (err) {
      logError(`resume: failed — ${errText(err)}`);
      if (this.running) {
        this.running = false;
        this.callbacks?.onClosed?.(err);
        await this.cleanup();
      }
    } finally {
      this.resuming = false;
    }
  }

  async write(data: string | Uint8Array): Promise<void> {
    const char = this.txChar;
    if (!char) throw new Error("no writable characteristic found on this device.");
    const bytes = typeof data === "string" ? this.encoder.encode(data) : data;
    const writeWithoutResponse = char.properties.writeWithoutResponse === true;
    logDebug(`write: ${bytes.length} byte(s) to ${char.uuid} (${writeWithoutResponse ? "without response" : "with response"})`);
    for (let offset = 0; offset < bytes.length; offset += 20) {
      const chunk = bytes.slice(offset, offset + 20);
      try {
        if (writeWithoutResponse) {
          await char.writeValueWithoutResponse(chunk);
        } else {
          await char.writeValue(chunk);
        }
      } catch (err) {
        logWarn(`write: failed at offset ${offset} — ${errText(err)}`);
        throw err;
      }
    }
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.stopWatchdog();
    logInfo("disconnect: cleaning up");
    await this.exclusive(() => this.cleanup());
  }

  private async cleanup(): Promise<void> {
    const notifyChars = this.notifyChars;
    this.notifyChars = [];
    this.txChar = null;
    const valueHandler = this.valueHandler;
    this.valueHandler = null;
    const disconnectHandler = this.disconnectHandler;
    this.disconnectHandler = null;
    for (const c of notifyChars) {
      if (valueHandler) c.removeEventListener("characteristicvaluechanged", valueHandler);
      try {
        await c.stopNotifications();
      } catch (err) {
        logDebug(`cleanup: stopNotifications on ${c.uuid} failed — ${errText(err)}`);
      }
    }
    if (this.device && disconnectHandler) {
      this.device.removeEventListener("gattserverdisconnected", disconnectHandler);
    }
    try {
      this.device?.gatt?.disconnect();
    } catch (err) {
      logDebug(`cleanup: gatt.disconnect failed — ${errText(err)}`);
    }
    this.device = null;
    this.buffer = "";
    logInfo("disconnect: done");
  }
}