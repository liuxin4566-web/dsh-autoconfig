/** Serial console transport for routers/switches/firewalls (USB or built-in COM). */
import { createRequire } from "node:module";
import { createAutoLogin } from "./prompt.js";

const nodeRequire = createRequire(import.meta.url);

export const SERIAL_DEFAULTS = Object.freeze({
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: "none"
});

let serialModule;

async function loadSerialPort() {
  if (serialModule !== undefined) return serialModule;
  try {
    // CJS first: DSH's host loader does not preserve Node's named-export
    // detection for every package, but createRequire always returns the real
    // module.exports object.
    const required = nodeRequire("serialport");
    serialModule = required?.SerialPort ? required : required?.default;
    if (typeof serialModule?.SerialPort !== "function") {
      throw new Error("serialport module did not expose a SerialPort constructor");
    }
    return serialModule;
  } catch (error) {
    serialModule = null;
    const hint = "serialport is not available in this DSH profile. Reinstall dsh-autoconfig with install scripts allowed (pnpm approve-builds) or use SSH/Telnet instead.";
    const wrapped = new Error(`${hint} (${error?.message ?? error})`);
    wrapped.code = "serialport-unavailable";
    throw wrapped;
  }
}

/** Enumerate serial ports for the connect dialog. */
export async function listSerialPorts() {
  const mod = await loadSerialPort();
  const ports = await mod.SerialPort.list();
  return ports.map((port) => ({
    path: port.path,
    manufacturer: port.manufacturer ?? null,
    serialNumber: port.serialNumber ?? null,
    vendorId: port.vendorId ?? null,
    productId: port.productId ?? null
  }));
}

export class SerialTransport {
  constructor({ path, baudRate, dataBits, stopBits, parity, username, password, autoLogin = true, onOutput, onClose, onNotice }) {
    this.path = path;
    this.options = {
      path,
      baudRate: baudRate ?? SERIAL_DEFAULTS.baudRate,
      dataBits: dataBits ?? SERIAL_DEFAULTS.dataBits,
      stopBits: stopBits ?? SERIAL_DEFAULTS.stopBits,
      parity: parity ?? SERIAL_DEFAULTS.parity,
      autoOpen: false
    };
    this.onOutput = onOutput;
    this.onClose = onClose;
    this.onNotice = onNotice ?? (() => {});
    this.port = null;
    this.closed = false;
    this.autoLogin = createAutoLogin({
      username,
      password,
      enabled: autoLogin !== false,
      send: (text) => this.write(Buffer.from(text, "utf8")),
      onNotice: this.onNotice
    });
  }

  async open() {
    const { SerialPort } = await loadSerialPort();
    const port = new SerialPort(this.options);
    this.port = port;
    port.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.onOutput(text);
      this.autoLogin.feed(text);
    });
    port.on("error", (error) => {
      this.onNotice(`Serial port error: ${error.message}`);
    });
    port.on("close", () => this.#handleClose());
    await new Promise((resolve, reject) => {
      port.open((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  #handleClose() {
    if (this.closed) return;
    this.closed = true;
    this.onClose({ code: null, signal: null });
  }

  write(buffer) {
    if (!this.port || !this.port.isOpen) throw new Error("serial port is not open");
    this.port.write(buffer);
    return buffer.length;
  }

  // Serial consoles have a fixed line rate; there is no window to resize.
  resize() {}

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.port?.close(() => {});
    } catch {}
  }
}
