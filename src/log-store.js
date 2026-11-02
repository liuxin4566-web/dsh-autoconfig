/**
 * Per-connection session recorder for dsh-autoconfig.
 *
 * Every connection owns one append-only `.log` file plus a JSON sidecar. The
 * file name is built from the device identity the user cares about:
 *
 *     <hostname>_<ip>_<YYYYMMDD-HHmmss>.log
 *
 * The hostname is initially the operator-supplied name (or host/COM port) and
 * is renamed in place as soon as the real device hostname is discovered from
 * the CLI prompt. Renaming keeps the connection timestamp, and the sidecar is
 * moved with it, so the pair a user sees in Explorer is always self-consistent.
 *
 * Recording is bounded: one session stops writing past its cap (and records
 * that fact once), and the directory is pruned to a global budget by removing
 * the oldest finished logs.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export const LOG_LIMITS = Object.freeze({
  maxSessionBytes: 32 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxReadBytes: 4 * 1024 * 1024
});

const LOG_SUFFIX = ".log";
const META_SUFFIX = ".json";

function pad(value) {
  return String(value).padStart(2, "0");
}

/** Local-time file stamp: 20261027-231530. */
export function formatLogStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Filesystem-safe component, never empty. */
export function sanitizePart(value, fallback = "device", max = 48) {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+$/, "_")
    .slice(0, max);
  return cleaned === "" ? fallback : cleaned;
}

/** `hostname_ip_stamp`, with no extension. */
export function buildLogBase({ hostname, ip, date = new Date() }) {
  return `${sanitizePart(hostname, "device")}_${sanitizePart(ip, "noip")}_${formatLogStamp(date)}`;
}

/** True when `file` is a plain basename inside the log directory. */
function safeFileName(file) {
  const name = basename(String(file ?? ""));
  return name !== "" && name === String(file) && !name.includes("..");
}

export class LogStore {
  constructor({ dir, limits = {} } = {}) {
    this.dir = dir;
    this.limits = { ...LOG_LIMITS, ...limits };
    this.live = new Map();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
  }

  /**
   * Reserve a unique base name for one new session. The suffix only appears on
   * a same-second, same-identity collision (rare, but two tabs can connect to
   * the same device together).
   */
  async reserve({ hostname, ip, date, exclude = null }) {
    await this.init();
    const root = buildLogBase({ hostname, ip, date });
    for (let index = 0; index < 100; index += 1) {
      const base = index === 0 ? root : `${root}_${index + 1}`;
      const logPath = join(this.dir, `${base}${LOG_SUFFIX}`);
      let taken = false;
      try {
        await stat(logPath);
        taken = true;
      } catch {}
      if (!taken && ![...this.live.values()].some((entry) => entry.base === base && entry !== exclude)) {
        return base;
      }
    }
    return `${root}_${Date.now()}`;
  }

  async begin(meta) {
    await this.init();
    const base = await this.reserve({
      hostname: meta.hostname ?? meta.name,
      ip: meta.ip,
      date: meta.startedAt ? new Date(meta.startedAt) : new Date()
    });
    const session = new LogSession(this, base, meta);
    await session.open();
    this.live.set(meta.connectionId, session);
    // Pruning is best-effort and never blocks a connection.
    void this.prune().catch(() => {});
    return session;
  }

  /** Newest first. Live metadata wins over the on-disk sidecar. */
  async list() {
    await this.init().catch(() => {});
    let names = [];
    try {
      names = await readdir(this.dir);
    } catch {
      names = [];
    }
    const byFile = new Map();
    for (const name of names) {
      if (!name.endsWith(META_SUFFIX)) continue;
      try {
        const meta = JSON.parse(await readFile(join(this.dir, name), "utf8"));
        if (typeof meta?.file !== "string") continue;
        byFile.set(meta.file, meta);
      } catch {
        // A half-written sidecar is skipped rather than breaking the list.
      }
    }
    for (const session of this.live.values()) {
      byFile.set(session.file, session.meta);
    }
    // Live sidecars are persisted only at open/rename/close, so take the byte
    // count from the file itself to keep the panel's log list accurate.
    for (const meta of byFile.values()) {
      try {
        meta.bytes = (await stat(join(this.dir, meta.file))).size;
      } catch {}
    }
    return [...byFile.values()].sort((left, right) =>
      String(right.startedAt ?? "").localeCompare(String(left.startedAt ?? ""))
    );
  }

  /** Read a byte range of one log; the caller pages with `nextOffset`. */
  async read(file, { offset = 0, maxBytes = 65536 } = {}) {
    if (!safeFileName(file)) return { ok: false, reason: "bad-file" };
    const path = join(this.dir, file);
    let size;
    try {
      size = (await stat(path)).size;
    } catch {
      return { ok: false, reason: "no-such-log" };
    }
    const start = Math.max(0, Math.min(Number(offset) || 0, size));
    const length = Math.max(1, Math.min(Number(maxBytes) || 65536, this.limits.maxReadBytes));
    if (start >= size) {
      return { ok: true, data: "", startOffset: start, nextOffset: start, eof: true, size };
    }
    const chunks = [];
    let read = 0;
    await new Promise((done) => {
      const stream = createReadStream(path, { start, end: Math.min(size, start + length) - 1 });
      stream.on("data", (chunk) => {
        chunks.push(chunk);
        read += chunk.length;
      });
      stream.on("error", () => done());
      stream.on("end", done);
    });
    return {
      ok: true,
      data: Buffer.concat(chunks).toString("utf8"),
      startOffset: start,
      nextOffset: start + read,
      eof: start + read >= size,
      size
    };
  }

  async remove(file) {
    if (!safeFileName(file)) return { ok: false, reason: "bad-file" };
    const base = file.replace(/\.log$/, "");
    await rm(join(this.dir, file), { force: true }).catch(() => {});
    await rm(join(this.dir, `${base}${META_SUFFIX}`), { force: true }).catch(() => {});
    return { ok: true, deleted: true };
  }

  /** Keep the directory under its budget by dropping the oldest finished logs. */
  async prune() {
    const logs = await this.list();
    const liveFiles = new Set([...this.live.values()].map((session) => session.file));
    let total = 0;
    for (const log of logs) total += Number(log.bytes) || 0;
    if (total <= this.limits.maxTotalBytes) return;
    for (const log of [...logs].reverse()) {
      if (total <= this.limits.maxTotalBytes) break;
      if (liveFiles.has(log.file)) continue;
      await this.remove(log.file);
      total -= Number(log.bytes) || 0;
    }
  }
}

class LogSession {
  constructor(store, base, meta) {
    this.store = store;
    this.base = base;
    this.meta = {
      connectionId: meta.connectionId,
      protocol: meta.protocol,
      host: meta.host ?? null,
      port: meta.port ?? null,
      username: meta.username ?? null,
      name: meta.name ?? null,
      hostname: meta.hostname ?? meta.name ?? null,
      ip: meta.ip ?? null,
      agent: meta.agent === true,
      startedAt: meta.startedAt ?? new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      bytes: 0,
      truncated: false,
      file: `${base}${LOG_SUFFIX}`
    };
    this.path = join(store.dir, this.meta.file);
    this.metaPath = join(store.dir, `${base}${META_SUFFIX}`);
    this.stream = null;
    this.queue = Promise.resolve();
    this.closed = false;
  }

  get file() {
    return this.meta.file;
  }

  get dir() {
    return this.store.dir;
  }

  header() {
    const m = this.meta;
    return [
      "=".repeat(78),
      "dsh-autoconfig session",
      `protocol : ${m.protocol}`,
      `name     : ${m.name ?? ""}`,
      `hostname : ${m.hostname ?? ""}`,
      `host     : ${m.host ?? ""}${m.port ? `:${m.port}` : ""}`,
      `ip       : ${m.ip ?? ""}`,
      `username : ${m.username ?? ""}`,
      `started  : ${m.startedAt}`,
      `log      : ${m.file}`,
      "=".repeat(78),
      ""
    ].join("\r\n");
  }

  async open() {
    await this.store.init();
    this.stream = createWriteStream(this.path, { flags: "a" });
    this.stream.on("error", () => {
      /* a broken log must never crash a live session */
    });
    this.raw(this.header());
    await this.persist();
  }

  /** Ordered append; callers never await, but the queue keeps byte order. */
  raw(text) {
    if (this.closed || this.meta.truncated) return;
    const chunk = String(text ?? "");
    if (chunk === "") return;
    const size = Buffer.byteLength(chunk, "utf8");
    const remaining = this.store.limits.maxSessionBytes - this.meta.bytes;
    if (remaining <= 0) {
      this.markTruncated();
      return;
    }
    const slice = size > remaining ? Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8") : chunk;
    this.meta.bytes += Buffer.byteLength(slice, "utf8");
    if (this.meta.bytes >= this.store.limits.maxSessionBytes) this.markTruncated();
    const stream = this.stream;
    if (stream === null) return;
    this.queue = this.queue.then(
      () => new Promise((done) => {
        try {
          stream.write(slice, done);
        } catch {
          done();
        }
      })
    );
  }

  markTruncated() {
    if (this.meta.truncated) return;
    this.meta.truncated = true;
    try {
      this.stream?.write("\r\n### LOG TRUNCATED: session size limit reached\r\n");
    } catch {}
  }

  output(text) {
    this.raw(text);
  }

  /** A human-meaningful input line, not the raw keystroke stream. */
  input(source, text, { sensitive = false } = {}) {
    if (text === "") return;
    const stamp = new Date().toISOString();
    const body = sensitive ? "[redacted]" : String(text).replace(/[\r\n]+/g, " ").slice(0, 2000);
    this.raw(`\r\n### [${stamp}] INPUT (${source}): ${body}\r\n`);
  }

  notice(text) {
    this.raw(`\r\n### [${new Date().toISOString()}] ${String(text).replace(/[\r\n]+/g, " ")}\r\n`);
  }

  /** Rename the live log (and sidecar) when the real device hostname appears. */
  async renameHostname(hostname) {
    if (this.closed) return false;
    const next = String(hostname ?? "").trim();
    if (next === "" || next === this.meta.hostname) return false;
    await this.queue.catch(() => {});
    const base = await this.store.reserve({
      hostname: next,
      ip: this.meta.ip,
      date: new Date(this.meta.startedAt),
      exclude: this
    });
    if (base === this.base) {
      this.meta.hostname = next;
      await this.persist();
      return false;
    }
    await new Promise((done) => {
      try {
        this.stream?.end(done);
      } catch {
        done();
      }
    });
    const nextLog = `${base}${LOG_SUFFIX}`;
    const nextMeta = `${base}${META_SUFFIX}`;
    try {
      await rename(this.path, join(this.store.dir, nextLog));
      await rename(this.metaPath, join(this.store.dir, nextMeta)).catch(() => {});
    } catch {
      // Rename failed (file locked by an indexer, for example): keep recording
      // under the old name rather than losing the session.
      this.stream = createWriteStream(this.path, { flags: "a" });
      this.stream.on("error", () => {});
      return false;
    }
    this.base = base;
    this.meta.hostname = next;
    this.meta.file = nextLog;
    this.path = join(this.store.dir, nextLog);
    this.metaPath = join(this.store.dir, nextMeta);
    this.stream = createWriteStream(this.path, { flags: "a" });
    this.stream.on("error", () => {});
    this.notice(`hostname detected: ${next}`);
    await this.persist();
    return true;
  }

  async persist() {
    try {
      await writeFile(this.metaPath, JSON.stringify(this.meta, null, 2), "utf8");
    } catch {}
  }

  async close({ exitCode = null } = {}) {
    if (this.closed) return this.meta;
    this.meta.endedAt = new Date().toISOString();
    this.meta.exitCode = exitCode;
    this.raw(`\r\n${"=".repeat(78)}\r\nsession closed ${this.meta.endedAt} exit=${exitCode ?? "n/a"} bytes=${this.meta.bytes}${this.meta.truncated ? " (truncated)" : ""}\r\n${"=".repeat(78)}\r\n`);
    this.closed = true;
    await this.queue.catch(() => {});
    await new Promise((done) => {
      try {
        this.stream?.end(done);
      } catch {
        done();
      }
    });
    this.stream = null;
    await this.persist();
    return this.meta;
  }
}

/** Resolve the default log directory under DSH's home. */
export function defaultLogDir(homedir) {
  return join(homedir, ".dsh", "autoconfig-logs");
}

export { resolve, safeFileName };
