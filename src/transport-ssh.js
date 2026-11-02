/**
 * SSH / SFTP transport.
 *
 * One connection owns one interactive shell channel (or, for the `sftp`
 * protocol, only the SFTP subsystem). Output is decoded as UTF-8 and forwarded
 * to the owning session; input is written raw so function keys, Ctrl-C and
 * terminal applications behave exactly as in a normal SSH client.
 *
 * ssh2 is bundled into the host artifact: DSH's profile resolver only wires
 * dependencies recorded by its package manager, and a portable plugin tarball
 * must keep working even when its dependency graph is installed by hand.
 */
import { Client } from "ssh2";
import { openSftp } from "./sftp-ops.js";

/**
 * Legacy KEX for older Huawei VRP / IOS / Comware builds that offer only
 * SHA-1 group14. Appended after every modern algorithm: a modern peer still
 * negotiates modern, and only a peer that speaks nothing else lands here.
 */
const LEGACY_KEX = Object.freeze({ kex: { append: ["diffie-hellman-group14-sha1"] } });

export const SSH_DEFAULTS = Object.freeze({
  readyTimeoutMs: 20000,
  keepaliveIntervalMs: 15000,
  keepaliveCountMax: 3
});

function isKexMismatch(error) {
  return /no matching key exchange|no matching kex|key exchange algorithm/i.test(String(error?.message ?? error ?? ""));
}

export class SshTransport {
  /**
   * @param {object} options
   * @param {"ssh"|"sftp"} options.protocol
   * @param {(text: string) => void} options.onOutput
   * @param {(exit: {code: number|null, signal: string|null}) => void} options.onClose
   * @param {(name: string) => void} [options.onHostname]
   * @param {(text: string) => void} [options.onNotice]
   */
  constructor({ protocol, host, port, username, password, privateKey, passphrase, cols = 80, rows = 24, legacy = undefined, onOutput, onClose, onHostname, onNotice }) {
    this.protocol = protocol;
    this.host = host;
    this.port = port;
    this.username = username;
    this.password = password;
    this.privateKey = privateKey;
    this.passphrase = passphrase;
    this.cols = cols;
    this.rows = rows;
    this.legacy = legacy;
    this.onOutput = onOutput;
    this.onClose = onClose;
    this.onHostname = onHostname;
    this.onNotice = onNotice ?? (() => {});
    this.client = null;
    this.stream = null;
    this.sftp = null;
    this.exit = null;
    this.closed = false;
    this.usedLegacy = false;
  }

  async open() {
    if (this.legacy === true) return this.#connect(true);
    try {
      return await this.#connect(false);
    } catch (error) {
      if (this.legacy === false || !isKexMismatch(error)) throw error;
      this.onNotice("SSH handshake offered no modern key exchange; retrying with legacy group14-sha1.");
      return this.#connect(true);
    }
  }

  #config(legacy) {
    const config = {
      host: this.host,
      port: this.port,
      username: this.username,
      readyTimeout: SSH_DEFAULTS.readyTimeoutMs,
      keepaliveInterval: SSH_DEFAULTS.keepaliveIntervalMs,
      keepaliveCountMax: SSH_DEFAULTS.keepaliveCountMax,
      tryKeyboard: true,
      // Network appliances overwhelmingly present self-signed host keys and
      // often rotate them after a factory reset; the operator is connecting by
      // explicit address, so verification is deliberately off. This matches
      // dsh-ssh-ops' default hostKeyMode=off.
      hostVerifier: () => true,
      ...(legacy ? { algorithms: LEGACY_KEX } : {})
    };
    if (this.password) config.password = this.password;
    if (this.privateKey) {
      config.privateKey = this.privateKey;
      if (this.passphrase) config.passphrase = this.passphrase;
    }
    return config;
  }

  #connect(legacy) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      let ready = false;

      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        try {
          client.end();
        } catch {}
        reject(error);
      };
      const finishResolve = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.map(() => this.password ?? ""));
      });
      client.on("banner", (message) => {
        // OpenSSH pre-auth banners are worth showing once the shell exists; the
        // shell itself normally prints the MOTD, so keep this out of the log to
        // avoid duplicating it.
        void message;
      });
      client.on("ready", async () => {
        ready = true;
        this.client = client;
        this.usedLegacy = legacy;
        try {
          if (this.protocol === "sftp") {
            this.sftp = await openSftp(client);
            this.#execHostname();
          } else {
            await this.#openShell();
          }
          finishResolve();
        } catch (error) {
          finishReject(error);
        }
      });
      client.on("error", (error) => {
        if (!settled) finishReject(error);
        else if (ready) this.#handleClose({ code: null, signal: null });
      });
      client.on("close", () => {
        if (!settled) finishReject(new Error("SSH connection closed before authentication completed"));
        else if (ready) this.#handleClose(this.exit ?? { code: null, signal: null });
      });

      try {
        client.connect(this.#config(legacy));
      } catch (error) {
        finishReject(error);
      }
    });
  }

  #openShell() {
    return new Promise((resolve, reject) => {
      const options = {
        term: "xterm-256color",
        cols: this.cols,
        rows: this.rows,
        width: this.cols * 8,
        height: this.rows * 16
      };
      this.client.shell(options, (error, stream) => {
        if (!error) {
          this.#attachShell(stream);
          resolve();
          return;
        }
        // A few appliances refuse a PTY request but accept a raw shell. Try
        // once more without one before declaring the connection unusable.
        this.client.shell(false, (fallbackError, fallback) => {
          if (fallbackError) {
            reject(error);
            return;
          }
          this.#attachShell(fallback);
          resolve();
        });
      });
    });
  }

  #attachShell(stream) {
    this.stream = stream;
    stream.on("data", (chunk) => this.onOutput(chunk.toString("utf8")));
    stream.stderr?.on("data", (chunk) => this.onOutput(chunk.toString("utf8")));
    stream.on("exit", (code, signal) => {
      this.exit = {
        code: typeof code === "number" ? code : null,
        signal: typeof signal === "string" && signal !== "" ? signal : null
      };
    });
    stream.on("close", () => this.#handleClose(this.exit ?? { code: null, signal: null }));
    stream.on("error", () => this.#handleClose(this.exit ?? { code: null, signal: null }));
  }

  /** Linux SFTP hosts can answer `hostname` over a second exec channel. */
  #execHostname() {
    if (typeof this.onHostname !== "function") return;
    const timer = setTimeout(() => {}, SSH_DEFAULTS.readyTimeoutMs);
    timer.unref?.();
    try {
      this.client.exec("hostname", (error, stream) => {
        clearTimeout(timer);
        if (error || !stream) return;
        let output = "";
        stream.on("data", (chunk) => {
          output += chunk.toString("utf8");
          if (output.length > 512) output = output.slice(0, 512);
        });
        stream.on("error", () => {});
        stream.on("close", () => {
          const name = output.trim().split(/\s+/)[0] ?? "";
          if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name) && !/^(localhost|localhost\..*)$/i.test(name)) {
            this.onHostname(name);
          }
        });
      });
    } catch {
      clearTimeout(timer);
    }
  }

  #handleClose(exit) {
    if (this.closed) return;
    this.closed = true;
    this.exit = exit;
    try {
      this.sftp?.end?.();
    } catch {}
    this.onClose(exit);
  }

  write(buffer) {
    if (!this.stream) throw new Error("this SSH session has no interactive shell (SFTP-only connection)");
    this.stream.write(buffer);
    return buffer.length;
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    try {
      this.stream?.setWindow(rows, cols, 0, 0);
    } catch {}
  }

  async ensureSftp() {
    if (this.sftp) return this.sftp;
    if (!this.client) throw new Error("SSH connection is not open");
    this.sftp = await openSftp(this.client);
    return this.sftp;
  }

  close() {
    this.closed = true;
    try {
      this.stream?.end();
    } catch {}
    try {
      this.client?.end();
    } catch {}
  }
}
