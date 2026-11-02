import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTelnetParser, IAC, DO, WILL, WONT, SB, SE, OPT_ECHO, OPT_NAWS, OPT_TTYPE } from "../src/telnet.js";
import { detectHostname, normalizeIp, resolveIp } from "../src/prompt.js";
import { buildLogBase, LogStore, sanitizePart } from "../src/log-store.js";
import { connectResultSchema, listResultSchema, readResultSchema } from "../src/schemas.js";

test("telnet parser strips negotiation and answers options", () => {
  const out = [];
  const replies = [];
  const parser = createTelnetParser({
    onData: (bytes) => out.push(Buffer.from(bytes).toString("latin1")),
    onReply: (bytes) => replies.push(Buffer.from(bytes))
  });
  parser.negotiate();
  replies.length = 0;
  parser.feed(Buffer.from([
    IAC, WILL, OPT_ECHO,
    IAC, DO, OPT_TTYPE,
    ...Buffer.from("login: ", "ascii"),
    IAC, DO, 99,
    IAC, IAC,
    ...Buffer.from("x", "ascii")
  ]));
  assert.equal(out.join(""), "login: \u00ffx");
  const flat = replies.map((buffer) => [...buffer]);
  assert.deepEqual(flat[0], [IAC, DO, OPT_ECHO]);
  assert.deepEqual(flat[1], [IAC, WILL, OPT_TTYPE]);
  assert.deepEqual(flat[2], [IAC, WONT, 99]);
});

test("telnet parser handles split IAC sequences and NAWS", () => {
  const out = [];
  const replies = [];
  const parser = createTelnetParser({
    onData: (bytes) => out.push(Buffer.from(bytes).toString("utf8")),
    onReply: (bytes) => replies.push(Buffer.from(bytes))
  });
  parser.negotiate();
  replies.length = 0;
  parser.feed(Buffer.from([IAC, WILL]));
  parser.feed(Buffer.from([OPT_ECHO, 0x41]));
  parser.cols = 132;
  parser.rows = 43;
  parser.feed(Buffer.from([IAC, DO, OPT_NAWS]));
  assert.equal(out.join(""), "A");
  assert.deepEqual([...replies[0]], [IAC, DO, OPT_ECHO]);
  assert.deepEqual([...replies[1]], [IAC, WILL, OPT_NAWS]);
  const naws = replies[2];
  assert.equal(naws[0], IAC);
  assert.equal(naws[1], SB);
  assert.equal(naws[2], OPT_NAWS);
  assert.equal((naws[3] << 8) | naws[4], 132);
  assert.equal((naws[5] << 8) | naws[6], 43);
  assert.equal(naws[7], IAC);
  assert.equal(naws[8], SE);
});

test("telnet subnegotiation TTYPE SEND returns xterm-256color", () => {
  const replies = [];
  const parser = createTelnetParser({ onReply: (bytes) => replies.push(Buffer.from(bytes)) });
  parser.feed(Buffer.from([IAC, SB, OPT_TTYPE, 1, IAC, SE]));
  const text = Buffer.concat(replies).toString("latin1");
  assert.ok(text.includes("xterm-256color"));
});

test("prompt hostname detection covers network and POSIX prompts", () => {
  assert.equal(detectHostname("SW-Core#"), "SW-Core");
  assert.equal(detectHostname("\r\nSW-Core(config)#"), "SW-Core");
  assert.equal(detectHostname("\r\n<HUAWEI>\r\n"), "HUAWEI");
  assert.equal(detectHostname("\r\n[H3C]\r\n"), "H3C");
  assert.equal(detectHostname("admin@fw1:~$ "), "fw1");
  assert.equal(detectHostname("Router> "), "Router");
  assert.equal(detectHostname("Username: "), null);
  assert.equal(detectHostname("Password: "), null);
  assert.equal(detectHostname("login: "), null);
});

test("IP normalisation", async () => {
  assert.equal(normalizeIp("::ffff:10.0.0.1"), "10.0.0.1");
  assert.equal(normalizeIp("10.0.0.2"), "10.0.0.2");
  assert.equal(normalizeIp(undefined), "");
  assert.equal(await resolveIp("127.0.0.1"), "127.0.0.1");
});

test("log file name contains hostname, ip and timestamp", () => {
  const date = new Date(2026, 9, 27, 23, 15, 30);
  assert.equal(buildLogBase({ hostname: "SW Core", ip: "10.1.1.1", date }), "SW_Core_10.1.1.1_20261027-231530");
  assert.equal(sanitizePart("a/b:c*?"), "a_b_c__");
  assert.equal(sanitizePart(""), "device");
  assert.equal(sanitizePart("node", "device").length > 0, true);
});

test("log store records output, renames to discovered hostname, and lists metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-autoconfig-log-"));
  try {
    const store = new LogStore({ dir });
    const session = await store.begin({
      connectionId: "ac-test-1",
      protocol: "ssh",
      host: "10.1.1.1",
      port: 22,
      username: "admin",
      name: "core",
      hostname: "core",
      ip: "10.1.1.1",
      startedAt: new Date(2026, 9, 27, 23, 15, 30).toISOString()
    });
    assert.match(session.file, /^core_10\.1\.1\.1_20261027-231530\.log$/);
    session.output("display version\r\nHuawei VRP\r\n");
    session.input("agent", "display version");
    const renamed = await session.renameHostname("SW-Core");
    assert.equal(renamed, true);
    assert.match(session.file, /^SW-Core_10\.1\.1\.1_20261027-231530\.log$/);
    session.output("done\r\n");
    await session.close({ exitCode: 0 });

    const names = await readdir(dir);
    assert.ok(names.includes(session.file));
    assert.ok(names.includes(session.file.replace(/\.log$/, ".json")));
    assert.ok(!names.some((name) => name.startsWith("core_")));
    const body = await readFile(join(dir, session.file), "utf8");
    assert.ok(body.includes("display version"));
    assert.ok(body.includes("INPUT (agent): display version"));
    assert.ok(body.includes("session closed"));
    const listed = await store.list();
    assert.equal(listed[0].file, session.file);
    assert.equal(listed[0].hostname, "SW-Core");
    assert.equal(listed[0].exitCode, 0);
    const read = await store.read(session.file, { offset: 0, maxBytes: 1024 });
    assert.equal(read.ok, true);
    assert.ok(read.data.includes("Huawei VRP"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wire schemas accept the connection record shape", () => {
  const info = {
    connectionId: "ac-1",
    protocol: "ssh",
    host: "10.0.0.1",
    port: 22,
    username: "admin",
    name: "core",
    hostname: "SW-Core",
    ip: "10.0.0.1",
    connected: true,
    status: "open",
    openedAt: new Date().toISOString(),
    closedAt: null,
    logFile: "SW-Core_10.0.0.1_20261027-231530.log",
    agent: false,
    exitCode: null
  };
  assert.equal(connectResultSchema.parse({ ok: true, value: info }).ok, true);
  assert.equal(listResultSchema.parse({
    ok: true,
    value: { connections: [info], activeConnectionId: "ac-1", logDir: "C:/logs", protocols: ["ssh", "telnet", "console", "sftp"] }
  }).ok, true);
  assert.equal(readResultSchema.parse({
    ok: true,
    value: { data: "", startOffset: 0, offset: 0, exit: null }
  }).ok, true);
  assert.equal(readResultSchema.parse({
    ok: false,
    error: { code: "no-session", message: "gone" }
  }).ok, false);
});
