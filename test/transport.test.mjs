import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SshTransport } from "../src/transport-ssh.js";
import { TelnetTransport } from "../src/transport-telnet.js";
import { listDirectory, readFileBounded, writeFile } from "../src/sftp-ops.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "test-sshd.mjs");

function waitFor(predicate, timeoutMs = 8000, interval = 40) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, interval);
    };
    tick();
  });
}

async function startSshServer(port) {
  const sftpRoot = await mkdtemp(join(tmpdir(), "dsh-autoconfig-sftp-"));
  const child = spawn(process.execPath, [fixture, String(port), "--sftp-root", sftpRoot, "--reset-sftp-root"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
  await waitFor(() => output.includes("listening"), 12000);
  return {
    child,
    sftpRoot,
    async stop() {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      await rm(sftpRoot, { recursive: true, force: true }).catch(() => {});
    }
  };
}

test("SSH transport opens a shell, resizes, and serves SFTP", { timeout: 30000 }, async () => {
  const port = 2299;
  const server = await startSshServer(port);
  let transport;
  try {
    const output = [];
    let hostname = null;
    const closed = [];
    transport = new SshTransport({
      protocol: "ssh",
      host: "127.0.0.1",
      port,
      username: "test",
      password: "test123",
      cols: 100,
      rows: 30,
      onOutput: (text) => output.push(text),
      onClose: (exit) => closed.push(exit),
      onHostname: (name) => { hostname = name; }
    });
    await transport.open();
    assert.match(transport.constructor.name, /SshTransport/);
    transport.write(Buffer.from("echo HELLO-AUTOCONFIG\r\n"));
    await waitFor(() => output.join("").includes("HELLO-AUTOCONFIG"));
    transport.resize(120, 40);

    const sftp = await transport.ensureSftp();
    await writeFile(sftp, "integration.txt", Buffer.from("autoconfig-sftp\n"));
    const read = await readFileBounded(sftp, "integration.txt", 1024);
    assert.equal(read.data.toString("utf8"), "autoconfig-sftp\n");
    const entries = await listDirectory(sftp, ".");
    assert.ok(entries.some((entry) => entry.name === "integration.txt"));
    assert.ok(entries.some((entry) => entry.name === "welcome.txt"));
    void hostname;
    transport.close();
    await waitFor(() => closed.length > 0, 5000).catch(() => {});
  } finally {
    transport?.close();
    await server.stop();
  }
});

test("Telnet transport negotiates, auto-logs-in, echoes commands", { timeout: 20000 }, async () => {
  const received = [];
  const server = net.createServer((socket) => {
    let stage = "login";
    socket.write("Username: ");
    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8").replace(/\u0000/g, "");
      received.push(text);
      if (stage === "login" && /admin/.test(text)) {
        stage = "password";
        socket.write("\r\nPassword: ");
        return;
      }
      if (stage === "password" && /test123/.test(text)) {
        stage = "shell";
        socket.write("\r\nSW-Core# ");
        return;
      }
      if (stage === "shell" && /show version/.test(text)) {
        socket.write("\r\nVersion 7.1.0\r\nSW-Core# ");
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(2298, "127.0.0.1", resolve));
  let transport;
  try {
    const output = [];
    transport = new TelnetTransport({
      host: "127.0.0.1",
      port: 2298,
      username: "admin",
      password: "test123",
      cols: 100,
      rows: 30,
      autoLogin: true,
      onOutput: (text) => output.push(text),
      onClose: () => {},
      onNotice: () => {}
    });
    await transport.open();
    await waitFor(() => output.join("").includes("SW-Core#"));
    transport.write(Buffer.from("show version\r"));
    await waitFor(() => output.join("").includes("Version 7.1.0"));
    assert.ok(received.some((text) => text.includes("admin")));
    assert.ok(received.some((text) => text.includes("test123")));
    assert.ok(output.join("").includes("Username:"));
  } finally {
    transport?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
