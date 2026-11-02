/**
 * dsh-autoconfig host half.
 *
 * One `autoconfig` Typert Remote service owns every device connection:
 *
 *   protocol   transport
 *   ssh        ssh2 interactive shell (PTY), plus a lazily opened SFTP subsystem
 *   sftp       ssh2 auth + SFTP subsystem only
 *   telnet     raw TCP with RFC 854 option negotiation
 *   console    serial port (COM/tty) via the serialport binding
 *
 * Every byte received is appended to the connection journal (which feeds the
 * right-side terminal) and to an on-disk session log named
 * `<hostname>_<ip>_<YYYYMMDD-HHmmss>.log`. Agent input is echoed into the same
 * journal as a dim `[agent ...]` marker and written to the log as an INPUT
 * record, so the operator can see exactly what the model did.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile as writeLocalFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { ok, fail, failFrom } from "./envelope.js";
import { createTerminalOutput } from "./terminal-output.js";

const PROFILE_ROUTE = "/dsh-autoconfig/profiles";
import { LogStore, defaultLogDir } from "./log-store.js";
import { detectHostname, resolveIp, stripAnsi } from "./prompt.js";
import { SshTransport } from "./transport-ssh.js";
import { TelnetTransport } from "./transport-telnet.js";
import { SerialTransport, listSerialPorts } from "./transport-serial.js";
import {
  joinRemote,
  listDirectory,
  makeDirectory,
  readFileBounded,
  removePath,
  renamePath,
  statPath,
  writeFile
} from "./sftp-ops.js";
import { registerDeviceTools } from "./tools/devices.js";

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const MAX_SFTP_READ_BYTES = 4 * 1024 * 1024;
const MAX_SFTP_WRITE_BYTES = 16 * 1024 * 1024;
const MAX_CONNECTIONS = 32;
const STREAM_HEARTBEAT_MS = 15000;
const DEFAULT_PORTS = Object.freeze({ ssh: 22, sftp: 22, telnet: 23 });

function nowIso() {
  return new Date().toISOString();
}

function hhmmss() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()].map((value) => String(value).padStart(2, "0")).join(":");
}

/** Make arbitrary terminal input safe for a one-line marker. */
function displayInput(text) {
  return String(text)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\x1b/g, "\\e")
    .slice(0, 500);
}

/** Translate transport errors into operator-actionable Chinese messages. */
export function friendlyConnectError(error, { protocol, host, port } = {}) {
  const message = String(error?.message ?? error ?? "unknown error");
  const target = `${host ?? ""}${port ? `:${port}` : ""}`;
  if (/all configured authentication methods failed|authentication failure|permission denied|userauth/i.test(message)) {
    return `认证失败：${target} 拒绝了用户名/密码或密钥。请检查凭据（网络设备常要求先开启 SSH/Telnet 并配置本地用户）。原始错误：${message}`;
  }
  if (/no matching key exchange|no matching kex|key exchange algorithm/i.test(message)) {
    return `SSH 密钥交换算法不匹配：${target} 可能只支持旧版算法。请勾选“兼容旧设备（legacy）”。原始错误：${message}`;
  }
  if (/ECONNREFUSED|connection refused/i.test(message)) {
    return `连接被拒绝：${target} 未监听该端口，或防火墙/ACL 拦截。原始错误：${message}`;
  }
  if (/ETIMEDOUT|timed out|timeout/i.test(message)) {
    return `连接超时：${target} 不可达，或设备管理平面未放通。原始错误：${message}`;
  }
  if (/ENOTFOUND|getaddrinfo/i.test(message)) {
    return `域名解析失败：${host}。请确认地址或直接使用 IP。原始错误：${message}`;
  }
  if (/serialport-unavailable/i.test(message)) {
    return message;
  }
  if (protocol === "console" && /access denied|busy|cannot open|no such file/i.test(message)) {
    return `串口打开失败：${host ?? ""}。请确认 COM 口号、驱动、波特率，以及没有其他程序占用该端口。原始错误：${message}`;
  }
  return `连接失败：${target || protocol}。${message}`;
}

export default class AutoConfigService extends TypertRemoteService {
  static inject = ["tools", "credentials"];

  /** connectionId -> connection record */
  connections = new Map();
  activeConnectionId = null;
  /** Saved sessions file (coordinates only; passwords live in ctx.credentials). */
  profiles = null;

  constructor(ctx, config = {}) {
    super(ctx, "autoconfig");
    this.ctx = ctx;
    this.config = {
      logDir: defaultLogDir(homedir()),
      profileFile: join(homedir(), ".dsh", "autoconfig-profiles.json"),
      ...config
    };
    this.logs = new LogStore({ dir: this.config.logDir });
    this.counter = 0;

    ctx.effect(() => () => {
      for (const conn of this.connections.values()) {
        try {
          conn.transport?.close();
        } catch {}
        try {
          void conn.log?.close({ exitCode: conn.exit?.code ?? null });
        } catch {}
      }
      this.connections.clear();
      this.activeConnectionId = null;
    }, "dsh-autoconfig: cleanup");

    registerDeviceTools(ctx, this);

    // The session-bar RPC is served from a small same-origin JSON route instead
    // of a new Typert method: DSH caches a plugin's Typert manifest until the
    // next application start, so a newly added method would 404 after a hot
    // reload. The route keeps "remember this device" usable without a restart.
    ctx.inject(["connection", "webServer"], (hostCtx) => {
      hostCtx.effect(() => hostCtx.webServer.register({
        kind: "exact",
        path: PROFILE_ROUTE,
        handler: (request, response) => this._profileHttp(request, response)
      }), "dsh-autoconfig: saved-session route");
    });
  }

  // ── public RPC surface ─────────────────────────────────────────────────────

  async connect(request) {
    try {
      return ok(await this._connect(request));
    } catch (error) {
      return fail(error?.code ?? "connect-failed", error?.message ?? String(error));
    }
  }

  async list() {
    const connections = [...this.connections.values()].map((conn) => this._info(conn));
    const active = this._activeLive();
    return ok({
      connections,
      activeConnectionId: active?.id ?? null,
      logDir: this.config.logDir,
      protocols: ["ssh", "telnet", "console", "sftp"]
    });
  }

  async select(request) {
    const conn = this.connections.get(request.connectionId);
    if (!conn) return fail("no-session", `connection ${request.connectionId} does not exist`);
    this.activeConnectionId = conn.id;
    return ok({ activeConnectionId: conn.id });
  }

  // ── saved sessions (left connection bar) ───────────────────────────────────

  async profileSave(request) {
    const profiles = await this._ensureProfiles();
    const now = nowIso();
    const candidate = {
      protocol: request.protocol,
      host: request.host ?? null,
      port: request.port ?? null,
      username: request.username ?? null,
      name: request.name || request.host || request.serial?.path || "device",
      serial: request.protocol === "console" && request.serial ? { ...request.serial } : null,
      legacy: request.legacy === true,
      autoLogin: request.autoLogin !== false
    };
    const key = this._profileKey(candidate);
    let profile = profiles.find((entry) => this._profileKey(entry) === key);
    if (profile === undefined) {
      profile = {
        profileId: `prof-${randomUUID()}`,
        createdAt: now,
        hasPassword: false,
        ...candidate,
        lastUsedAt: now
      };
      profiles.push(profile);
    } else {
      Object.assign(profile, candidate, { lastUsedAt: now });
    }

    if (typeof request.password === "string" && request.password !== "" && request.savePassword !== false) {
      try {
        await this.ctx.credentials?.set(this._profileRef(profile.profileId), request.password);
        profile.hasPassword = true;
      } catch {
        profile.hasPassword = false;
      }
    } else if (request.savePassword === false) {
      try {
        await this.ctx.credentials?.unset(this._profileRef(profile.profileId));
      } catch {}
      profile.hasPassword = false;
    }

    await this._saveProfiles();
    return ok(this._profilePublic(profile));
  }

  async profileList() {
    const profiles = await this._ensureProfiles();
    return ok({
      profiles: profiles
        .map((profile) => this._profilePublic(profile))
        .sort((left, right) => String(right.lastUsedAt ?? "").localeCompare(String(left.lastUsedAt ?? "")))
    });
  }

  async profileDelete(request) {
    const profiles = await this._ensureProfiles();
    const index = profiles.findIndex((profile) => profile.profileId === request.profileId);
    if (index < 0) return ok({ deleted: false });
    const [removed] = profiles.splice(index, 1);
    await this._saveProfiles();
    try {
      await this.ctx.credentials?.unset(this._profileRef(removed.profileId));
    } catch {}
    return ok({ deleted: true });
  }

  async profileConnect(request) {
    const profiles = await this._ensureProfiles();
    const profile = profiles.find((entry) => entry.profileId === request.profileId);
    if (!profile) return fail("unknown-profile", `saved session ${request.profileId} does not exist`);

    let password;
    if (profile.hasPassword === true) {
      try {
        const resolved = await this.ctx.credentials?.resolve(this._profileRef(profile.profileId));
        password = resolved?.value;
      } catch {
        password = undefined;
      }
      if (typeof password !== "string" || password === "") {
        return fail("password-unavailable", "保存的密码不可用，请重新连接并在连接窗口中重新保存密码。");
      }
    }

    const result = await this.connect({
      protocol: profile.protocol,
      host: profile.host ?? undefined,
      port: profile.port ?? undefined,
      username: profile.username ?? undefined,
      password,
      name: profile.name || undefined,
      legacy: profile.legacy === true ? true : undefined,
      autoLogin: profile.autoLogin !== false,
      serial: profile.serial ?? undefined,
      saveProfile: false,
      profileId: profile.profileId
    });
    if (result.ok) {
      profile.lastUsedAt = nowIso();
      await this._saveProfiles().catch(() => {});
    }
    return result;
  }

  async write(request) {
    const conn = this.connections.get(request.connectionId);
    if (!conn) return fail("no-session", `connection ${request.connectionId} does not exist`);
    try {
      const buffer = Buffer.from(request.data ?? "", "base64");
      const written = this.writeRaw(conn, buffer, {
        source: request.source === "agent" ? "agent" : "panel",
        sensitive: request.sensitive === true
      });
      return ok({ written });
    } catch (error) {
      return failFrom(error, "write-failed");
    }
  }

  async read(request) {
    const conn = this.connections.get(request.connectionId);
    if (!conn) return fail("no-session", `connection ${request.connectionId} does not exist`);
    const timeoutMs = Number.isFinite(request.timeoutMs) ? request.timeoutMs : 300;
    if (request.after === undefined) {
      const all = conn.journal.readWindow(undefined, MAX_READ_BYTES);
      return ok({
        data: Buffer.from(all.data, "utf8").toString("base64"),
        startOffset: all.offset,
        offset: all.nextOffset,
        exit: conn.exit
      });
    }
    let window = conn.journal.readWindow(request.after, MAX_READ_BYTES);
    if (window.data === "" && conn.exit === null) {
      await this._wait(conn, timeoutMs);
      window = conn.journal.readWindow(request.after, MAX_READ_BYTES);
    }
    return ok({
      data: Buffer.from(window.data, "utf8").toString("base64"),
      startOffset: window.offset,
      offset: window.nextOffset,
      exit: conn.exit
    });
  }

  async *terminalStream(request, signal) {
    const conn = this.connections.get(request.connectionId);
    if (!conn) {
      yield fail("no-session", `connection ${request.connectionId} does not exist`);
      return;
    }
    let after = Number.isSafeInteger(request.after) ? request.after : 0;
    let exitSent = false;
    while (!signal?.aborted) {
      // Bounded windows keep the browser's per-message highlighting cost
      // predictable even when replaying a multi-megabyte journal.
      const window = conn.journal.readWindow(after, MAX_READ_BYTES);
      after = window.nextOffset;
      if (window.data !== "") {
        yield ok({
          data: Buffer.from(window.data, "utf8").toString("base64"),
          startOffset: window.offset,
          offset: window.nextOffset,
          exit: conn.exit
        });
      }
      if (conn.exit !== null) {
        if (!exitSent) {
          exitSent = true;
          yield ok({ data: "", startOffset: after, offset: after, exit: conn.exit });
        }
        return;
      }
      const woke = await this._wait(conn, STREAM_HEARTBEAT_MS, signal);
      if (!woke && !signal?.aborted) {
        // Keepalive: an empty item proves the stream carrier is alive while the
        // device is quiet. The client ignores it (zero bytes).
        yield ok({ data: "", startOffset: after, offset: after, exit: null });
      }
    }
  }

  async resize(request) {
    const conn = this.connections.get(request.connectionId);
    if (!conn) return fail("no-session", `connection ${request.connectionId} does not exist`);
    conn.cols = request.cols;
    conn.rows = request.rows;
    try {
      conn.transport?.resize(request.cols, request.rows);
    } catch {}
    return ok({ cols: request.cols, rows: request.rows });
  }

  async close(request) {
    const conn = this.connections.get(request.connectionId);
    if (!conn) return ok({ closed: false });
    this._closeConnection(conn, conn.exit ?? { code: null, signal: null });
    return ok({ closed: true });
  }

  async serialPorts() {
    try {
      return ok({ ports: await listSerialPorts() });
    } catch (error) {
      return fail(error?.code ?? "serial-enumerate-failed", error?.message ?? String(error));
    }
  }

  // ── SFTP ───────────────────────────────────────────────────────────────────

  async sftpList(request) {
    const conn = this.connections.get(request.connectionId);
    if (!conn) return fail("no-session", "connection does not exist");
    try {
      const sftp = await this._sftp(conn);
      const path = request.path === undefined || request.path === "" ? "." : request.path;
      const entries = await listDirectory(sftp, path);
      entries.sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
      if (!request.quiet) this._note(conn, `[sftp] LIST ${path} -> ${entries.length} entries`);
      return ok({ path, entries });
    } catch (error) {
      if (!request.quiet) this._note(conn, `[sftp] LIST ${request.path ?? "."} FAILED: ${error.message}`);
      return failFrom(error, "sftp-list-failed");
    }
  }

  async sftpReadFile(request) {
    const conn = this.connections.get(request.connectionId);
    if (!conn) return fail("no-session", "connection does not exist");
    try {
      const sftp = await this._sftp(conn);
      const maxBytes = Math.min(request.maxBytes ?? 1024 * 1024, MAX_SFTP_READ_BYTES);
      const { data, truncated, size } = await readFileBounded(sftp, request.path, maxBytes);
      this._note(conn, `[sftp] READ ${request.path} (${data.length}/${size} bytes${truncated ? ", truncated" : ""})`);
      return ok({ path: request.path, data: data.toString("base64"), bytes: data.length, truncated });
    } catch (error) {
      this._note(conn, `[sftp] READ ${request.path} FAILED: ${error.message}`);
      return failFrom(error, "sftp-read-failed");
    }
  }

  async sftpWriteFile(request) {
    const conn = this.connections.get(request.connectionId);
    if (!conn) return fail("no-session", "connection does not exist");
    try {
      const buffer = Buffer.from(request.data ?? "", "base64");
      if (buffer.length > MAX_SFTP_WRITE_BYTES) {
        return fail("file-too-large", `file is ${buffer.length} bytes; limit is ${MAX_SFTP_WRITE_BYTES}`);
      }
      const sftp = await this._sftp(conn);
      const result = await writeFile(sftp, request.path, buffer);
      this._note(conn, `[sftp] WRITE ${request.path} (${result.bytes} bytes)`);
      return ok(result);
    } catch (error) {
      this._note(conn, `[sftp] WRITE ${request.path} FAILED: ${error.message}`);
      return failFrom(error, "sftp-write-failed");
    }
  }

  async sftpMkdir(request) {
    const conn = this.connections.get(request.connectionId);
    if (!conn) return fail("no-session", "connection does not exist");
    try {
      const sftp = await this._sftp(conn);
      const result = await makeDirectory(sftp, request.path);
      this._note(conn, `[sftp] MKDIR ${request.path}`);
      return ok(result);
    } catch (error) {
      this._note(conn, `[sftp] MKDIR ${request.path} FAILED: ${error.message}`);
      return failFrom(error, "sftp-mkdir-failed");
    }
  }

  async sftpDelete(request) {
    const conn = this.connections.get(request.connectionId);
    if (!conn) return fail("no-session", "connection does not exist");
    try {
      const sftp = await this._sftp(conn);
      const result = await removePath(sftp, request.path);
      this._note(conn, `[sftp] DELETE ${request.path}${result.isDirectory ? " (directory)" : ""}`);
      return ok(result);
    } catch (error) {
      this._note(conn, `[sftp] DELETE ${request.path} FAILED: ${error.message}`);
      return failFrom(error, "sftp-delete-failed");
    }
  }

  async sftpRename(request) {
    const conn = this.connections.get(request.connectionId);
    if (!conn) return fail("no-session", "connection does not exist");
    try {
      if (request.to.includes("/")) {
        // Keep the operation inside the directory the operator sees; a rename
        // across directories is a move, which must be explicit.
        return fail("invalid-target", "rename target must be a file name, not a path");
      }
      const sftp = await this._sftp(conn);
      const from = request.from;
      const to = joinRemote(posix.dirname(from), request.to);
      const result = await renamePath(sftp, from, to);
      this._note(conn, `[sftp] RENAME ${from} -> ${to}`);
      return ok(result);
    } catch (error) {
      this._note(conn, `[sftp] RENAME ${request.from} FAILED: ${error.message}`);
      return failFrom(error, "sftp-rename-failed");
    }
  }

  // ── logs ───────────────────────────────────────────────────────────────────

  async logList() {
    try {
      const logs = await this.logs.list();
      return ok({ dir: this.config.logDir, logs });
    } catch (error) {
      return failFrom(error, "log-list-failed");
    }
  }

  async logRead(request) {
    try {
      const result = await this.logs.read(request.file, {
        offset: request.offset ?? 0,
        maxBytes: request.maxBytes ?? 65536
      });
      if (!result.ok) return fail(result.reason, `cannot read log ${request.file}`);
      return ok({
        file: request.file,
        data: Buffer.from(result.data, "utf8").toString("base64"),
        startOffset: result.startOffset,
        nextOffset: result.nextOffset,
        eof: result.eof,
        size: result.size
      });
    } catch (error) {
      return failFrom(error, "log-read-failed");
    }
  }

  async logDelete(request) {
    try {
      return ok(await this.logs.remove(request.file));
    } catch (error) {
      return failFrom(error, "log-delete-failed");
    }
  }

  // ── service methods used by agent tools ────────────────────────────────────

  /** Resolve an explicit id or fall back to the panel's active live session. */
  resolveTarget(connectionId) {
    if (connectionId !== undefined && connectionId !== null && connectionId !== "") {
      const conn = this.connections.get(connectionId);
      if (!conn) throw Object.assign(new Error(`connection ${connectionId} does not exist`), { code: "no-session" });
      return conn;
    }
    const active = this._activeLive();
    if (active) return active;
    const latest = [...this.connections.values()].reverse().find((conn) => conn.status === "open");
    if (latest) return latest;
    throw Object.assign(
      new Error("没有活动的设备连接。请先用 device_connect 连接设备，或让操作者在右侧面板连接。"),
      { code: "no-active-connection" }
    );
  }

  writeAgentInput(connectionId, text, { sensitive = false, pressEnter = false } = {}) {
    const conn = this.resolveTarget(connectionId);
    let data = String(text ?? "");
    if (pressEnter && !/[\r\n]$/.test(data)) data += "\r";
    const buffer = Buffer.from(data, "utf8");
    const written = this.writeRaw(conn, buffer, { source: "agent", sensitive });
    return { connectionId: conn.id, written };
  }

  readAgentOutput(connectionId, mode = "new") {
    const conn = this.resolveTarget(connectionId);
    if (mode === "tail") {
      const window = conn.journal.readWindow(undefined, MAX_READ_BYTES);
      return {
        connectionId: conn.id,
        data: window.data,
        startOffset: window.historyStart,
        nextOffset: window.nextOffset,
        truncated: window.wasClamped || window.historyStart > 0,
        closed: conn.exit !== null
      };
    }
    const from = Number.isSafeInteger(conn.agentReadOffset) ? conn.agentReadOffset : 0;
    const window = conn.journal.readWindow(from, MAX_READ_BYTES);
    conn.agentReadOffset = window.nextOffset;
    return {
      connectionId: conn.id,
      data: window.data,
      startOffset: window.offset,
      nextOffset: window.nextOffset,
      truncated: window.hasMore,
      closed: conn.exit !== null
    };
  }

  listForAgent() {
    return [...this.connections.values()].map((conn) => ({
      ...this._info(conn),
      active: conn.id === this.activeConnectionId
    }));
  }

  closeConnection(connectionId) {
    const conn = this.resolveTarget(connectionId);
    this._closeConnection(conn, conn.exit ?? { code: null, signal: null });
    return { connectionId: conn.id, closed: true };
  }

  /** Tool-facing SFTP facade: keeps the transcript and error handling uniform. */
  async sftpTool(connectionId, action, input = {}) {
    const conn = this.resolveTarget(connectionId);
    switch (action) {
      case "list": return this.sftpList({ connectionId: conn.id, path: input.path });
      case "stat": {
        try {
          const sftp = await this._sftp(conn);
          const info = await statPath(sftp, input.path);
          this._note(conn, `[sftp] STAT ${input.path}`);
          return ok({ path: input.path, ...info });
        } catch (error) {
          return failFrom(error, "sftp-stat-failed");
        }
      }
      case "read": return this.sftpReadFile({ connectionId: conn.id, path: input.path, maxBytes: input.maxBytes });
      case "write": return this.sftpWriteFile({ connectionId: conn.id, path: input.path, data: input.data });
      case "mkdir": return this.sftpMkdir({ connectionId: conn.id, path: input.path });
      case "remove": return this.sftpDelete({ connectionId: conn.id, path: input.path });
      case "rename": return this.sftpRename({ connectionId: conn.id, from: input.path, to: input.to });
      default: return fail("bad-action", `unknown SFTP action ${action}`);
    }
  }

  async readLogText(file, { offset = 0, maxBytes = 64 * 1024 } = {}) {
    const result = await this.logs.read(file, { offset, maxBytes });
    if (!result.ok) throw Object.assign(new Error(`cannot read log ${file}`), { code: result.reason });
    return result;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  async _profileHttp(request, response) {
    const send = (status, payload) => {
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify(payload));
    };
    try {
      const origin = request.headers.origin;
      if (typeof origin === "string" && origin !== "") {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(origin).host === request.headers.host;
        } catch {}
        if (!sameOrigin) {
          send(403, { ok: false, error: { code: "forbidden", message: "same-origin request required" } });
          return;
        }
      }

      if (request.method === "GET") {
        send(200, await this.profileList({}));
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "GET, POST" });
        response.end();
        return;
      }

      const chunks = [];
      let total = 0;
      for await (const chunk of request) {
        total += chunk.length;
        if (total > 64 * 1024) {
          send(413, { ok: false, error: { code: "payload-too-large", message: "request body exceeds 64 KB" } });
          return;
        }
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        send(400, { ok: false, error: { code: "bad-json", message: "request body is not JSON" } });
        return;
      }

      switch (body?.action) {
        case "save":
          send(200, await this.profileSave(body));
          return;
        case "delete":
          send(200, await this.profileDelete({ profileId: String(body.profileId ?? "") }));
          return;
        case "connect":
          send(200, await this.profileConnect({ profileId: String(body.profileId ?? "") }));
          return;
        default:
          send(400, { ok: false, error: { code: "bad-action", message: "action must be save, delete or connect" } });
      }
    } catch (error) {
      send(500, { ok: false, error: { code: "profile-route-failed", message: error?.message ?? String(error) } });
    }
  }

  async _ensureProfiles() {
    if (this.profiles !== null) return this.profiles;
    try {
      const parsed = JSON.parse(await readFile(this.config.profileFile, "utf8"));
      const list = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
      this.profiles = list.filter((profile) =>
        profile !== null
        && typeof profile === "object"
        && typeof profile.profileId === "string"
        && typeof profile.protocol === "string"
      );
    } catch {
      this.profiles = [];
    }
    return this.profiles;
  }

  async _saveProfiles() {
    await mkdir(dirname(this.config.profileFile), { recursive: true });
    await writeLocalFile(
      this.config.profileFile,
      JSON.stringify({ version: 1, profiles: this.profiles ?? [] }, null, 2),
      { mode: 0o600 }
    );
  }

  _profileRef(profileId) {
    const stem = String(profileId).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    return `DSH_AUTOCONFIG_${stem}_PASSWORD`;
  }

  _profileKey(profile) {
    return [
      profile.protocol ?? "",
      profile.host ?? "",
      profile.port ?? "",
      profile.username ?? "",
      profile.serial?.path ?? ""
    ].join("|");
  }

  _profilePublic(profile) {
    return {
      profileId: profile.profileId,
      protocol: profile.protocol,
      host: profile.host ?? null,
      port: profile.port ?? null,
      username: profile.username ?? null,
      name: String(profile.name ?? profile.host ?? profile.serial?.path ?? "device"),
      serial: profile.serial ?? null,
      legacy: profile.legacy === true,
      autoLogin: profile.autoLogin !== false,
      hasPassword: profile.hasPassword === true,
      createdAt: String(profile.createdAt ?? nowIso()),
      lastUsedAt: profile.lastUsedAt ?? null
    };
  }

  async _rememberConnection(conn, request) {
    const profiles = await this._ensureProfiles();
    const now = nowIso();
    const candidate = {
      protocol: conn.protocol,
      host: conn.host,
      port: conn.port,
      username: conn.username,
      name: conn.name,
      serial: conn.protocol === "console" && request.serial ? { ...request.serial } : null,
      legacy: request.legacy === true,
      autoLogin: request.autoLogin !== false
    };
    const key = this._profileKey(candidate);
    let profile = profiles.find((entry) => this._profileKey(entry) === key);
    if (profile === undefined) {
      profile = {
        profileId: `prof-${randomUUID()}`,
        createdAt: now,
        hasPassword: false,
        ...candidate,
        lastUsedAt: now
      };
      profiles.push(profile);
    } else {
      Object.assign(profile, candidate, { lastUsedAt: now });
    }

    if (request.savePassword === true && typeof request.password === "string" && request.password !== "") {
      try {
        await this.ctx.credentials?.set(this._profileRef(profile.profileId), request.password);
        profile.hasPassword = true;
      } catch {
        profile.hasPassword = false;
      }
    } else if (request.savePassword === false && profile.hasPassword === true) {
      try {
        await this.ctx.credentials?.unset(this._profileRef(profile.profileId));
      } catch {}
      profile.hasPassword = false;
    }

    await this._saveProfiles();
  }

  _activeLive() {
    const active = this.activeConnectionId ? this.connections.get(this.activeConnectionId) : undefined;
    if (active && active.status === "open") return active;
    return [...this.connections.values()].reverse().find((conn) => conn.status === "open") ?? null;
  }

  _info(conn) {
    return {
      connectionId: conn.id,
      protocol: conn.protocol,
      host: conn.host,
      port: conn.port,
      username: conn.username,
      name: conn.name,
      hostname: conn.hostname,
      ip: conn.ip,
      connected: conn.connected,
      status: conn.status,
      openedAt: conn.openedAt,
      closedAt: conn.closedAt,
      logFile: conn.logFile,
      agent: conn.agent,
      exitCode: conn.exit?.code ?? null
    };
  }

  async _connect(request) {
    const protocol = request.protocol;
    if (!["ssh", "telnet", "console", "sftp"].includes(protocol)) {
      throw Object.assign(new Error(`unsupported protocol ${protocol}`), { code: "bad-protocol" });
    }
    if (this.connections.size >= MAX_CONNECTIONS) {
      // Evict the oldest closed connection; live sessions are never dropped.
      const closed = [...this.connections.values()].find((conn) => conn.status !== "open");
      if (closed) this.connections.delete(closed.id);
      else throw Object.assign(new Error(`connection limit reached (${MAX_CONNECTIONS})`), { code: "too-many-connections" });
    }

    const port = request.port ?? DEFAULT_PORTS[protocol] ?? null;
    const host = protocol === "console" ? null : String(request.host ?? "").trim();
    if (protocol !== "console" && host === "") {
      throw Object.assign(new Error("host is required"), { code: "bad-request" });
    }
    if (protocol === "console" && !request.serial?.path) {
      throw Object.assign(new Error("serial.path is required for console connections"), { code: "bad-request" });
    }

    const id = `ac-${Date.now().toString(36)}-${(this.counter += 1)}-${randomUUID().slice(0, 4)}`;
    const openedAt = nowIso();
    const ip = protocol === "console" ? "serial" : await resolveIp(host);
    const requestedName = String(request.name ?? "").trim();
    const name = requestedName || (protocol === "console" ? request.serial.path : host);
    // Until the device prompt reveals its real hostname, the log uses the
    // operator-supplied name; without one, a neutral placeholder avoids a
    // redundant `ip_ip_timestamp.log` while keeping the three-part contract.
    const initialHostname = requestedName || (protocol === "console" ? request.serial.path : "device");

    const conn = {
      id,
      protocol,
      host,
      port: protocol === "console" ? null : port,
      username: request.username ?? null,
      name,
      hostname: null,
      ip,
      agent: request.agent === true,
      connected: false,
      status: "connecting",
      openedAt,
      closedAt: null,
      exit: null,
      finished: false,
      cols: request.cols ?? 80,
      rows: request.rows ?? 24,
      journal: createTerminalOutput("", MAX_JOURNAL_BYTES),
      wakers: new Set(),
      transport: null,
      log: null,
      logFile: null,
      agentReadOffset: 0,
      hostnameTimer: null
    };
    this.connections.set(id, conn);
    this.activeConnectionId = id;

    try {
      conn.log = await this.logs.begin({
        connectionId: id,
        protocol,
        host,
        port: conn.port,
        username: conn.username,
        name,
        hostname: initialHostname,
        ip,
        agent: conn.agent,
        startedAt: openedAt
      });
      conn.logFile = conn.log.file;
    } catch {
      // A recording failure must not prevent the operator from reaching a device.
      conn.log = null;
      conn.logFile = null;
    }

    this._local(conn, `\x1b[36m[dsh-autoconfig]\x1b[0m ${protocol.toUpperCase()} ${protocol === "console" ? request.serial.path : `${host}:${port}`}\r\n`);
    this._logNotice(conn, `connect: ${protocol} ${protocol === "console" ? request.serial.path : `${host}:${port}`}`);

    const callbacks = {
      onOutput: (text) => this._output(conn, text),
      onClose: (exit) => this._closeConnection(conn, exit, { remote: true }),
      onHostname: (nameValue) => this._discoverHostname(conn, nameValue),
      onNotice: (text) => {
        this._local(conn, `\x1b[90m[${text}]\x1b[0m\r\n`);
        this._logNotice(conn, text);
      }
    };

    let transport;
    if (protocol === "ssh" || protocol === "sftp") {
      transport = new SshTransport({
        protocol,
        host,
        port,
        username: request.username ?? "",
        password: request.password,
        privateKey: request.privateKey,
        passphrase: request.passphrase,
        cols: conn.cols,
        rows: conn.rows,
        legacy: request.legacy,
        ...callbacks
      });
    } else if (protocol === "telnet") {
      transport = new TelnetTransport({
        host,
        port,
        username: request.username,
        password: request.password,
        cols: conn.cols,
        rows: conn.rows,
        autoLogin: request.autoLogin !== false,
        ...callbacks
      });
    } else {
      transport = new SerialTransport({
        path: request.serial.path,
        baudRate: request.serial.baudRate,
        dataBits: request.serial.dataBits,
        stopBits: request.serial.stopBits,
        parity: request.serial.parity,
        username: request.username,
        password: request.password,
        autoLogin: request.autoLogin !== false,
        ...callbacks
      });
    }
    conn.transport = transport;

    try {
      await transport.open();
    } catch (error) {
      try {
        transport.close();
      } catch {}
      conn.status = "error";
      conn.connected = false;
      conn.error = friendlyConnectError(error, { protocol, host, port });
      this._local(conn, `\x1b[31m[connect failed]\x1b[0m ${conn.error}\r\n`);
      this._logNotice(conn, `connect failed: ${error.message}`);
      conn.exit = { code: null, signal: null };
      conn.finished = true;
      await conn.log?.close({ exitCode: null }).catch(() => {});
      this._wake(conn);
      this.connections.delete(id);
      if (this.activeConnectionId === id) this.activeConnectionId = this._activeLive()?.id ?? null;
      const failure = new Error(conn.error);
      failure.code = "connect-failed";
      throw failure;
    }

    conn.connected = true;
    conn.status = "open";
    conn.error = null;
    if (protocol === "telnet" && transport.remoteAddress) {
      conn.ip = transport.remoteAddress;
    }
    this._local(conn, `\x1b[32m[connected]\x1b[0m ${protocol}  log: ${conn.logFile ?? "(recording disabled)"}\r\n`);
    this._logNotice(conn, `connected; log=${conn.logFile ?? "none"}`);
    this._wake(conn);

    // Every successful connection becomes a reusable session-bar entry. Only
    // an explicit UI opt-in stores the password (in DSH's credential store, not
    // in the profiles JSON).
    if (request.profileId === undefined && request.agent === true) {
      try {
        await this._rememberConnection(conn, request);
      } catch {
        // A history write must never make a working connection look failed.
      }
    }

    return this._info(conn);
  }

  writeRaw(conn, buffer, { source = "panel", sensitive = false } = {}) {
    if (!conn.transport) throw new Error("connection transport is not ready");
    if (source === "agent") {
      const text = buffer.toString("utf8");
      this._agentMarker(conn, text, sensitive);
    }
    const written = conn.transport.write(buffer);
    this._wake(conn);
    return written;
  }

  _agentMarker(conn, text, sensitive) {
    const shown = sensitive ? "[redacted]" : displayInput(text);
    conn.journal.append(`\r\n\x1b[90m[agent ${hhmmss()}] ${shown}\x1b[0m\r\n`);
    try {
      conn.log?.input("agent", text, { sensitive });
    } catch {}
    this._wake(conn);
  }

  _output(conn, text) {
    if (text === "") return;
    conn.journal.append(text);
    try {
      conn.log?.output(text);
    } catch {}
    if (conn.hostname === null) {
      const detected = detectHostname(text);
      if (detected !== null) this._discoverHostname(conn, detected);
    }
    this._wake(conn);
  }

  _discoverHostname(conn, rawName) {
    const name = String(rawName ?? "").trim();
    if (name === "" || name === conn.hostname) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)) return;
    conn.hostname = name;
    const log = conn.log;
    if (log === null) return;
    void log.renameHostname(name).then((changed) => {
      conn.logFile = log.file;
      if (changed) {
        this._local(conn, `\x1b[90m[hostname] ${name}  log: ${log.file}\x1b[0m\r\n`, { log: false });
      }
    }).catch(() => {});
  }

  _local(conn, text, { log = false } = {}) {
    conn.journal.append(text);
    if (log) this._logNotice(conn, stripAnsi(text));
    this._wake(conn);
  }

  _logNotice(conn, text) {
    try {
      conn.log?.notice(text);
    } catch {}
  }

  _note(conn, text) {
    this._local(conn, `\x1b[90m${text}\x1b[0m\r\n`, { log: false });
    this._logNotice(conn, text);
  }

  _wait(conn, timeoutMs, signal = undefined) {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (woke) => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        conn.wakers.delete(finish);
        signal?.removeEventListener?.("abort", onAbort);
        resolve(woke);
      };
      const onAbort = () => finish(false);
      conn.wakers.add(finish);
      signal?.addEventListener?.("abort", onAbort, { once: true });
      timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      timer.unref?.();
    });
  }

  _wake(conn) {
    for (const waker of [...conn.wakers]) {
      try {
        waker(true);
      } catch {}
    }
  }

  _closeConnection(conn, exit, { remote = false } = {}) {
    if (conn.finished) return;
    conn.finished = true;
    conn.exit = exit ?? { code: null, signal: null };
    conn.connected = false;
    conn.status = "closed";
    conn.closedAt = nowIso();
    if (!remote) {
      try {
        conn.transport?.close();
      } catch {}
    }
    this._local(
      conn,
      `\r\n\x1b[90m[session closed${exit?.code !== null && exit?.code !== undefined ? ` exit=${exit.code}` : ""}]  log: ${conn.logFile ?? "none"}\x1b[0m\r\n`
    );
    this._logNotice(conn, `session closed exit=${exit?.code ?? "n/a"}`);
    void conn.log?.close({ exitCode: exit?.code ?? null }).catch(() => {});
    if (this.activeConnectionId === conn.id) this.activeConnectionId = this._activeLive()?.id ?? null;
    this._wake(conn);
  }

  async _sftp(conn) {
    if (conn.protocol !== "ssh" && conn.protocol !== "sftp") {
      throw Object.assign(new Error("SFTP is only available on SSH/SFTP connections"), { code: "sftp-unsupported" });
    }
    if (!conn.transport || conn.status !== "open") {
      throw Object.assign(new Error("connection is not open"), { code: "no-session" });
    }
    return conn.transport.ensureSftp();
  }
}
