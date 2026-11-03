import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtemp, readFile as readTextFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";

import AutoConfigService from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "test-sshd.mjs");

function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, 40);
    };
    tick();
  });
}

async function waitForAsync(predicate, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function makeService(logDir) {
  const ctx = new Context();
  const tools = [];
  const secrets = new Map();
  ctx.reflect.provide("tools", { register(tool) { tools.push(tool.name); } });
  ctx.reflect.provide("credentials", {
    async set(ref, value) { secrets.set(ref, value); },
    async unset(ref) { secrets.delete(ref); },
    async resolve(ref) { return secrets.has(ref) ? { value: secrets.get(ref), source: "file" } : undefined; },
    async describe(ref) { return { configured: secrets.has(ref), writable: true }; }
  });
  const service = new AutoConfigService(ctx, { logDir, profileFile: join(logDir, "profiles.json"), rag: { autoCollect: false } });
  return { ctx, service, tools, secrets };
}

async function startSshServer(port, sftpRoot) {
  const child = spawn(process.execPath, [fixture, String(port), "--sftp-root", sftpRoot, "--reset-sftp-root"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  await waitFor(() => output.includes("listening"), 12000);
  return child;
}

test("host service connects, streams, logs, SFTPs, and closes", { timeout: 30000 }, async () => {
  const logDir = await mkdtemp(join(tmpdir(), "dsh-autoconfig-service-"));
  const sftpRoot = await mkdtemp(join(tmpdir(), "dsh-autoconfig-service-sftp-"));
  const { service, tools, secrets } = makeService(logDir);
  const child = await startSshServer(2301, sftpRoot);
  try {
    assert.deepEqual(tools, [
      "device_connect", "device_list", "device_send", "device_read", "device_close", "device_sftp", "device_logs",
      "kb_search", "kb_docs", "device_profile", "plan_create", "plan_execute", "plan_status", "plan_diagnose", "plan_revise", "plan_abort"
    ]);

    const connected = await service.connect({
      protocol: "ssh",
      host: "127.0.0.1",
      port: 2301,
      username: "test",
      password: "test123",
      name: "lab-sw",
      cols: 100,
      rows: 30,
      savePassword: true
    });
    assert.equal(connected.ok, true, connected.error?.message);
    const connection = connected.value;
    assert.equal(connection.status, "open");
    assert.equal(connection.ip, "127.0.0.1");
    assert.match(connection.logFile, /^lab-sw_127\.0\.0\.1_\d{8}-\d{6}\.log$/);

    const saved = await service.profileSave({
      protocol: "ssh",
      host: "127.0.0.1",
      port: 2301,
      username: "test",
      password: "test123",
      name: "lab-sw",
      savePassword: true
    });
    assert.equal(saved.ok, true, saved.error?.message);
    const savedSessions = await service.profileList();
    assert.equal(savedSessions.ok, true);
    assert.equal(savedSessions.value.profiles.length, 1);
    const profile = savedSessions.value.profiles[0];
    assert.equal(profile.name, "lab-sw");
    assert.equal(profile.hasPassword, true);
    assert.equal(secrets.size, 1);
    const profileText = await readTextFile(join(logDir, "profiles.json"), "utf8");
    assert.ok(!profileText.includes("test123"), "password must not be written to the profiles file");

    const input = Buffer.from("echo SERVICE-HELLO\r\n", "utf8").toString("base64");
    const written = await service.write({ connectionId: connection.connectionId, data: input, source: "agent" });
    assert.equal(written.ok, true);
    await waitForAsync(async () => {
      const read = await service.read({ connectionId: connection.connectionId, after: 0 });
      return Buffer.from(read.value.data, "base64").toString("utf8").includes("SERVICE-HELLO");
    });

    // Agent read cursor: first read consumes everything, second returns nothing.
    const first = service.readAgentOutput(connection.connectionId, "new");
    assert.ok(first.data.includes("SERVICE-HELLO"));
    assert.ok(first.data.includes("[agent"));
    const second = service.readAgentOutput(connection.connectionId, "new");
    assert.equal(second.data, "");

    const listed = await service.sftpList({ connectionId: connection.connectionId, path: "." });
    assert.equal(listed.ok, true);
    assert.ok(listed.value.entries.some((entry) => entry.name === "welcome.txt"));
    const readFile = await service.sftpReadFile({ connectionId: connection.connectionId, path: "welcome.txt" });
    assert.equal(Buffer.from(readFile.value.data, "base64").toString("utf8"), "hello from test-sshd\n");
    const writeFile = await service.sftpWriteFile({
      connectionId: connection.connectionId,
      path: "service.txt",
      data: Buffer.from("written-by-service\n").toString("base64")
    });
    assert.equal(writeFile.ok, true, writeFile.error?.message);

    const logs = await service.logList();
    assert.equal(logs.ok, true);
    assert.ok(logs.value.logs.some((log) => log.file === connection.logFile));

    await service.close({ connectionId: connection.connectionId });
    const after = await service.list();
    assert.equal(after.value.connections.find((conn) => conn.connectionId === connection.connectionId).status, "closed");
    await waitForAsync(async () => {
      const body = await service.readLogText(connection.logFile, { offset: 0, maxBytes: 1024 * 1024 });
      return body.data.includes("session closed") && body.data.includes("SERVICE-HELLO");
    });
    const body = await service.readLogText(connection.logFile, { offset: 0, maxBytes: 1024 * 1024 });
    assert.ok(body.data.includes("INPUT (agent): echo SERVICE-HELLO"));

    const names = await readdir(logDir);
    assert.ok(names.includes(connection.logFile));
    assert.ok(names.includes(connection.logFile.replace(/\.log$/, ".json")));

    // Double-click reconnect uses the password from the credential store.
    const reconnected = await service.profileConnect({ profileId: profile.profileId });
    assert.equal(reconnected.ok, true, reconnected.error?.message);
    assert.equal(reconnected.value.status, "open");
    await service.close({ connectionId: reconnected.value.connectionId });

    const removed = await service.profileDelete({ profileId: profile.profileId });
    assert.equal(removed.value.deleted, true);
    assert.equal((await service.profileList()).value.profiles.length, 0);
    assert.equal(secrets.size, 0);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve)).catch(() => {});
    await rm(logDir, { recursive: true, force: true }).catch(() => {});
    await rm(sftpRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("telnet host service discovers the prompt hostname and renames the log", { timeout: 20000 }, async () => {
  const logDir = await mkdtemp(join(tmpdir(), "dsh-autoconfig-service-telnet-"));
  const { service } = makeService(logDir);
  const server = net.createServer((socket) => {
    socket.write("Username: ");
    let stage = "login";
    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (stage === "login" && /admin/.test(text)) {
        stage = "password";
        socket.write("\r\nPassword: ");
        return;
      }
      if (stage === "password" && /test123/.test(text)) {
        stage = "shell";
        socket.write("\r\nSW-Core# ");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(2302, "127.0.0.1", resolve));
  try {
    const connected = await service.connect({
      protocol: "telnet",
      host: "127.0.0.1",
      port: 2302,
      username: "admin",
      password: "test123",
      name: "telnet-lab",
      autoLogin: true
    });
    assert.equal(connected.ok, true, connected.error?.message);
    const connection = connected.value;
    await waitFor(() => {
      const listed = service.listForAgent().find((entry) => entry.connectionId === connection.connectionId);
      return listed?.hostname === "SW-Core";
    });
    await waitForAsync(async () => {
      const listed = service.listForAgent().find((entry) => entry.connectionId === connection.connectionId);
      return Boolean(listed && /^SW-Core_/.test(listed.logFile ?? ""));
    });
    const after = service.listForAgent().find((entry) => entry.connectionId === connection.connectionId);
    assert.match(after.logFile, /^SW-Core_127\.0\.0\.1_\d{8}-\d{6}\.log$/);
    const logs = await service.logList();
    assert.ok(logs.value.logs.some((log) => log.file === after.logFile));
    await service.close({ connectionId: connection.connectionId });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(logDir, { recursive: true, force: true }).catch(() => {});
  }
});
