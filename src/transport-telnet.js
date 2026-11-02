/** Telnet transport: raw TCP plus RFC 854 option negotiation. */
import net from "node:net";
import { createTelnetParser } from "./telnet.js";
import { createAutoLogin, normalizeIp } from "./prompt.js";

export const TELNET_DEFAULTS = Object.freeze({ connectTimeoutMs: 15000 });

export class TelnetTransport {
  constructor({ host, port, username, password, cols = 80, rows = 24, autoLogin = true, onOutput, onClose, onHostname, onNotice }) {
    this.host = host;
    this.port = port;
    this.username = username;
    this.password = password;
    this.cols = cols;
    this.rows = rows;
    this.onOutput = onOutput;
    this.onClose = onClose;
    this.onHostname = onHostname;
    this.onNotice = onNotice ?? (() => {});
    this.socket = null;
    this.parser = null;
    this.closed = false;
    this.remoteAddress = null;
    this.autoLogin = createAutoLogin({
      username,
      password,
      enabled: autoLogin !== false,
      send: (text) => this.write(Buffer.from(text, "utf8")),
      onNotice: this.onNotice
    });
  }

  open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30000);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`Telnet connection timed out after ${TELNET_DEFAULTS.connectTimeoutMs}ms`));
      }, TELNET_DEFAULTS.connectTimeoutMs);

      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.remoteAddress = normalizeIp(socket.remoteAddress);
        this.parser = createTelnetParser({
          onData: (bytes) => {
            const text = Buffer.from(bytes).toString("utf8");
            this.onOutput(text);
            this.autoLogin.feed(text);
          },
          onReply: (bytes) => {
            try {
              socket.write(bytes);
            } catch {}
          }
        });
        this.parser.cols = this.cols;
        this.parser.rows = this.rows;
        this.parser.negotiate();
        resolve();
      });

      socket.on("data", (chunk) => this.parser?.feed(chunk));
      socket.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        } else {
          this.onNotice(`Telnet socket error: ${error.message}`);
        }
      });
      socket.on("close", () => {
        clearTimeout(timer);
        this.remoteAddress = normalizeIp(socket.remoteAddress);
        this.#handleClose();
      });
    });
  }

  #handleClose() {
    if (this.closed) return;
    this.closed = true;
    this.onClose({ code: null, signal: null });
  }

  write(buffer) {
    if (!this.socket || this.socket.destroyed) throw new Error("Telnet connection is closed");
    this.socket.write(buffer);
    return buffer.length;
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    try {
      this.parser?.resize(cols, rows);
    } catch {}
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.end();
    } catch {}
    try {
      this.socket?.destroy();
    } catch {}
  }
}
