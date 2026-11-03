/**
 * Device profile store and read-only collection.
 *
 * A profile is plain JSON so it can be exported and shared with a team; it is
 * keyed by serial number when the device exposes one, otherwise by
 * protocol+address. Passwords never enter this file.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { runCommand, tailText, cleanCommandOutput } from "./terminal.js";
import { getVendor, detectVendorFromText, VENDORS } from "./vendors.js";

export const DEVICE_FILE = join(homedir(), ".dsh", "autoconfig-devices.json");

const ERROR_HINT = /(?:found at '\^' position|Invalid input detected|Unrecognized command|Incomplete command|Wrong parameter|Too many parameters|Ambiguous command|Error:)/i;

async function readStore() {
  try {
    const parsed = JSON.parse(await readFile(DEVICE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? { version: 1, devices: parsed.devices ?? {} } : { version: 1, devices: {} };
  } catch {
    return { version: 1, devices: {} };
  }
}

async function writeStore(store) {
  await mkdir(join(homedir(), ".dsh"), { recursive: true });
  await writeFile(DEVICE_FILE, JSON.stringify(store, null, 2), "utf8");
}

export async function listDevices() {
  const store = await readStore();
  return Object.values(store.devices).sort((left, right) => String(right.collectedAt ?? "").localeCompare(String(left.collectedAt ?? "")));
}

export async function getDevice(deviceId) {
  const store = await readStore();
  return store.devices[deviceId] ?? null;
}

export async function upsertDevice(profile) {
  const store = await readStore();
  store.devices[profile.deviceId] = profile;
  await writeStore(store);
  return profile;
}

export async function removeDevice(deviceId) {
  const store = await readStore();
  delete store.devices[deviceId];
  await writeStore(store);
  return { removed: true };
}

export async function exportDevices() {
  const store = await readStore();
  return { version: 1, exportedAt: new Date().toISOString(), devices: Object.values(store.devices) };
}

export async function importDevices(payload) {
  const incoming = Array.isArray(payload?.devices) ? payload.devices : Array.isArray(payload) ? payload : [];
  const store = await readStore();
  let imported = 0;
  for (const profile of incoming) {
    if (!profile || typeof profile !== "object" || typeof profile.deviceId !== "string") continue;
    store.devices[profile.deviceId] = profile;
    imported += 1;
  }
  await writeStore(store);
  return { imported, total: Object.keys(store.devices).length };
}

export function deviceIdFor({ serial, protocol, host, port, serialPath }) {
  const key = serial && String(serial).trim()
    ? `sn:${String(serial).trim()}`
    : `${protocol ?? "ssh"}://${host ?? serialPath ?? "device"}:${port ?? ""}`;
  return key.toLowerCase().replace(/\s+/g, "");
}

function firstMatch(patterns, text) {
  for (const pattern of patterns ?? []) {
    const match = pattern.exec(text);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

function guessVendor(conn) {
  const tail = tailText(conn.journal.readWindow(undefined, 4_000).data, 2_000);
  if (/<H3C>|\[H3C|Comware/i.test(tail)) return "h3c";
  if (/<HUAWEI>|\[HUAWEI|Huawei/i.test(tail)) return "huawei";
  if (/Maipu|迈普/i.test(tail)) return "maipu";
  if (/Ruijie|锐捷/i.test(tail)) return "ruijie";
  if (/Cisco/i.test(tail)) return "cisco";
  if (/<[^>]+>/.test(tail)) return "huawei";
  return null;
}

async function tryCommand(service, conn, command, vendor, timeoutMs = 9_000) {
  try {
    const result = await runCommand(service, conn, command, { vendor, timeoutMs, source: "probe" });
    const output = cleanCommandOutput(result.text, command);
    return { command, output, raw: result.text, timedOut: result.timedOut, error: ERROR_HINT.test(output) };
  } catch (error) {
    return { command, output: "", raw: "", timedOut: false, error: true, message: error.message };
  }
}

/**
 * Collect vendor/model/version/serial with read-only commands.
 * `vendorHint` comes from the operator or from the saved profile.
 */
export async function collectDeviceProfile(service, conn, { vendorHint = null } = {}) {
  let vendorId = vendorHint ? String(vendorHint).toLowerCase() : guessVendor(conn);
  let vendor = getVendor(vendorId);
  let versionOutput = "";
  const raw = {};

  const runVersion = async (id) => {
    const profile = getVendor(id);
    if (!profile) return null;
    for (const command of profile.version) {
      const attempt = await tryCommand(service, conn, command, profile);
      raw[command] = attempt.raw;
      if (!attempt.error && attempt.output) {
        versionOutput = attempt.output;
        return attempt.output;
      }
    }
    return null;
  };

  if (!vendor) {
    // Try Comware/VRP first; fall back to IOS-style `show version`.
    for (const candidate of ["h3c", "huawei", "maipu", "ruijie", "cisco"]) {
      const output = await runVersion(candidate);
      if (output) {
        vendorId = candidate;
        vendor = getVendor(candidate);
        break;
      }
    }
  } else {
    const output = await runVersion(vendorId);
    if (!output) {
      const detected = detectVendorFromText(Object.values(raw).join("\n"));
      if (detected && detected !== vendorId) {
        vendorId = detected;
        vendor = getVendor(detected);
        await runVersion(vendorId);
      }
    }
  }
  if (!vendor) {
    throw Object.assign(new Error("无法识别设备厂商；请在连接时指定 vendor，或在面板中手动填写。"), { code: "vendor-unknown" });
  }
  if (!versionOutput) {
    const detected = detectVendorFromText(Object.values(raw).join("\n"));
    if (detected) versionOutput = Object.values(raw).join("\n");
  }

  const combined = Object.values(raw).join("\n");
  const model = firstMatch(vendor.modelPatterns, combined);
  let version = firstMatch(vendor.versionPatterns, versionOutput || combined);
  if (version) version = version.replace(/,\s*Alpha\s+(\d+)/i, " Alpha $1").trim();

  for (const command of vendor.serial) {
    if (raw[command]) continue;
    const attempt = await tryCommand(service, conn, command, vendor, 8_000);
    raw[command] = attempt.raw;
  }
  const serial = firstMatch(vendor.serialPatterns, Object.values(raw).join("\n"));

  const hostname = conn.hostname ?? null;
  const deviceId = deviceIdFor({
    serial,
    protocol: conn.protocol,
    host: conn.host,
    port: conn.port,
    serialPath: conn.serialPath
  });
  const profile = {
    deviceId,
    name: conn.name,
    hostname,
    vendor: vendor.id,
    platform: vendor.platform,
    model,
    version,
    serial,
    protocol: conn.protocol,
    host: conn.host ?? null,
    port: conn.port ?? null,
    collectedAt: new Date().toISOString(),
    commandSet: vendor.id,
    raw: Object.fromEntries(Object.entries(raw).map(([command, text]) => [command, String(text ?? "").slice(0, 12_000)])),
    bindings: []
  };
  await upsertDevice(profile);
  return profile;
}

export function vendorOptions() {
  return Object.values(VENDORS).map((vendor) => ({ id: vendor.id, label: vendor.label, platform: vendor.platform }));
}