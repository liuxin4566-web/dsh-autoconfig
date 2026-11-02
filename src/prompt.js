/**
 * Prompt / identity helpers shared by the Telnet and serial transports.
 *
 * Network CLIs do not advertise their hostname out of band. The only reliable
 * signal before login is the prompt (`SW-Core#`, `<HUAWEI>`, `[H3C]`,
 * `admin@fw1:~$`, ...). We parse the tail of the output and ignore generic
 * words that appear in login banners so a "Password:" prompt can never become
 * the recorded device name.
 */
import dns from "node:dns/promises";
import net from "node:net";

const GENERIC = new Set([
  "login", "password", "passwd", "username", "user", "name", "enable",
  "config", "configure", "configuration", "system", "system-view", "console",
  "terminal", "yes", "no", "y", "n", "continue", "press", "any", "key"
]);

export function stripAnsi(text) {
  // CSI, OSC and single-character escapes.
  return String(text ?? "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "");
}

/**
 * Extract a plausible device hostname from the most recent prompt, or null.
 * Only the tail is inspected because MOTD text may contain example prompts.
 */
export function detectHostname(text) {
  const clean = stripAnsi(text).slice(-4096);
  const candidates = [];
  const tail = clean;

  // admin@SW-Core:~$ / root@fw1:/etc#
  let match = /(?:^|[\r\n])([^\r\n@]{1,64})@([A-Za-z0-9][A-Za-z0-9._-]{1,62})[:~][^\r\n]*[#$]\s*$/.exec(tail);
  if (match) candidates.push(match[2]);

  // SW-Core# / SW-Core(config)# / SW-Core> / <HUAWEI> / [H3C] / [~HUAWEI]
  match = /(?:^|[\r\n])<?\[?~?([A-Za-z0-9][A-Za-z0-9._-]{1,62})(?:\([^)\r\n]{0,40}\))?[>#]\s*$/.exec(tail);
  if (match) candidates.push(match[1]);
  match = /(?:^|[\r\n])<([A-Za-z0-9][A-Za-z0-9._-]{1,62})>\s*$/.exec(tail);
  if (match) candidates.push(match[1]);
  match = /(?:^|[\r\n])\[~?([A-Za-z0-9][A-Za-z0-9._-]{1,62})\]\s*$/.exec(tail);
  if (match) candidates.push(match[1]);

  for (const candidate of candidates) {
    const name = candidate.trim();
    if (name.length < 2 || name.length > 63) continue;
    if (GENERIC.has(name.toLowerCase())) continue;
    if (!/[A-Za-z]/.test(name)) continue;
    return name;
  }
  return null;
}

/**
 * Answer Telnet/serial login prompts automatically. Only active when the
 * operator supplied both a username and a password. Each credential is sent
 * exactly once; the state machine stops at "done" so later password-like text
 * in configuration output can never be answered.
 */
export function createAutoLogin({ username, password, enabled = true, send, onNotice = () => {} }) {
  let state = enabled && username && password ? "login" : "done";
  let tail = "";

  return {
    get state() {
      return state;
    },
    feed(text) {
      if (state === "done") return;
      tail = (tail + stripAnsi(text)).slice(-2048);
      if (state === "login" && /(?:login|user\s*name|username|user)\s*[:：]\s*$/i.test(tail)) {
        send(`${username}\r`);
        state = "password";
        onNotice("auto-login: username sent");
        return;
      }
      if (state === "password" && /(?:password|passwd)\s*[:：]\s*$/i.test(tail)) {
        send(`${password}\r`);
        state = "done";
        tail = "";
        onNotice("auto-login: password sent");
      }
    }
  };
}

/** Resolve a host to an address for the log filename; fall back to the host. */
export async function resolveIp(host) {
  if (typeof host !== "string" || host === "") return null;
  if (net.isIP(host) !== 0) return host;
  try {
    const lookup = dns.lookup(host, { verbatim: true });
    const result = await Promise.race([
      lookup,
      new Promise((_, reject) => setTimeout(() => reject(new Error("dns timeout")), 2000))
    ]);
    if (result && typeof result.address === "string") return result.address;
  } catch {}
  return host;
}

/** Normalise Node's IPv4-mapped IPv6 form for display and file names. */
export function normalizeIp(value) {
  const text = String(value ?? "").trim();
  if (text.startsWith("::ffff:")) return text.slice(7);
  return text;
}
