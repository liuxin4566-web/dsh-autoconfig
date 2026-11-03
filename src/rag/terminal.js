/**
 * Terminal primitives for probes and plan execution.
 *
 * The right-side terminal is the only surface: every command written here is
 * echoed with a `[probe]`/`[plan]` marker and recorded in the session log, so
 * the operator sees exactly what the agent sent and when.
 */
import { stripAnsi } from "../prompt.js";

export const DEFAULT_PROMPT_TIMEOUT_MS = 12_000;
const POLL_MS = 80;

export { stripAnsi };

export function tailText(text, limit = 800) {
  const clean = stripAnsi(String(text ?? "")).replace(/\r/g, "").replace(/[\u0000\u0007]/g, "");
  return clean.slice(-limit);
}

export function isPrompt(text, vendor) {
  const tail = tailText(text, 600);
  if (!tail) return false;
  if (vendor?.prompt?.some((pattern) => pattern.test(tail))) return true;
  // Generic fallbacks: `SW#`, `SW>`, `<H3C>`, `[H3C]`.
  return /(?:^|[\r\n])(?:<[^>\r\n]{1,64}>|\[~?[^\]\r\n]{1,64}\]|[A-Za-z0-9._-]{1,64}(?:\([^)\r\n]{1,40}\))?[>#])\s*$/.test(tail);
}

export function extractPrompt(text, vendor) {
  const tail = tailText(text, 600);
  const lines = tail.split(/\r?\n/).filter((line) => line.trim() !== "");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (vendor?.prompt?.some((pattern) => pattern.test(line)) || /^(?:<[^>]{1,64}>|\[~?[^\]\r\n]{1,64}\]|[A-Za-z0-9._-]{1,64}(?:\([^)\r\n]{1,40}\))?[>#])$/.test(line)) {
      return line;
    }
  }
  return null;
}

function markedWrite(service, conn, text, { source, sensitive = false, pressEnter = true, note = "" }) {
  const data = pressEnter && !/[\r\n]$/.test(text) ? `${text}\r` : text;
  if (!sensitive) {
    const shown = data.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
    const noteText = note ? ` — ${String(note).replace(/[\r\n]+/g, " ").slice(0, 180)}` : "";
    service._local(conn, `\r\n\x1b[90m[${source}] ${shown}${noteText}\x1b[0m\r\n`);
  } else {
    service._local(conn, `\r\n\x1b[90m[${source}] [redacted]\x1b[0m\r\n`);
  }
  try {
    conn.log?.input(source, data, { sensitive });
  } catch {}
  const written = conn.transport.write(Buffer.from(data, "utf8"));
  service._wake(conn);
  return written;
}

export function writeRawMarked(service, conn, text, { source = "probe", sensitive = false } = {}) {
  return markedWrite(service, conn, text, { source, sensitive, pressEnter: false });
}

export function writeCommand(service, conn, command, { source = "probe", sensitive = false, note = "" } = {}) {
  return markedWrite(service, conn, command, { source, sensitive, pressEnter: true, note });
}

function readFrom(conn, offset) {
  const window = conn.journal.readWindow(offset);
  return { text: window.data, next: window.nextOffset };
}

const MORE_PATTERN = /(?:----\s*More\s*----|--More--)\s*$/i;

export async function waitForPrompt(service, conn, { vendor, timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS, startedAt = Date.now(), initialOffset = conn.journal.length } = {}) {
  let offset = initialOffset;
  let collected = "";
  let lastData = Date.now();
  let handledMore = false;
  while (Date.now() - startedAt < timeoutMs) {
    if (conn.exit !== null) break;
    const { text, next } = readFrom(conn, offset);
    if (text) {
      collected += text;
      offset = next;
      lastData = Date.now();
      if (MORE_PATTERN.test(tailText(collected, 120))) {
        // Page through long output; the probe must never look hung to the user.
        writeRawMarked(service, conn, " ", { source: "probe" });
        handledMore = true;
      }
    }
    if (collected && Date.now() - lastData > 120 && isPrompt(collected, vendor) && Date.now() - startedAt > 150) {
      return { text: collected, nextOffset: offset, prompt: extractPrompt(collected, vendor), timedOut: false, handledMore };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const final = readFrom(conn, offset);
  collected += final.text;
  return { text: collected, nextOffset: final.nextOffset, prompt: extractPrompt(collected, vendor), timedOut: true, handledMore };
}

/** Send one command and wait for the next prompt. */
export async function runCommand(service, conn, command, { vendor, timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS, source = "probe", sensitive = false, note = "" } = {}) {
  const startedAt = Date.now();
  const offset = conn.journal.length;
  writeCommand(service, conn, command, { source, sensitive, note });
  const result = await waitForPrompt(service, conn, { vendor, timeoutMs, startedAt, initialOffset: offset });
  return { command, ...result };
}

/**
 * Send a command that asks for confirmation (save / reboot / delete). The reply
 * is sent only after the device's confirmation pattern appears, never blindly.
 */
export async function runInteractive(service, conn, command, { vendor, reply, replyWhen = /(?:\[Y\/N\]|\(y\/n\)|Are you sure|\[confirm\]|Please input)/i, timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS, source = "plan", note = "" } = {}) {
  const startedAt = Date.now();
  let offset = conn.journal.length;
  writeCommand(service, conn, command, { source, note });
  let collected = "";
  let replied = false;
  while (Date.now() - startedAt < timeoutMs) {
    if (conn.exit !== null) break;
    const { text, next } = readFrom(conn, offset);
    offset = next;
    if (text) {
      collected += text;
      if (!replied && reply && replyWhen.test(tailText(collected, 500))) {
        writeRawMarked(service, conn, `${reply}\r`, { source: `${source} reply` });
        replied = true;
      }
    }
    if (collected && isPrompt(collected, vendor) && Date.now() - startedAt > 200) {
      return { command, text: collected, prompt: extractPrompt(collected, vendor), timedOut: false, replied };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return { command, text: collected, prompt: null, timedOut: true, replied };
}

/**
 * Type a partial command plus `?` (no Enter), read the help, then abort the
 * line with Ctrl-C. Nothing is executed, so this is safe to run without a new
 * approval while the plan is approved.
 */
export async function probeHelp(service, conn, prefix, { vendor, waitMs = 1_400 } = {}) {
  const offset = conn.journal.length;
  if (prefix) writeRawMarked(service, conn, prefix, { source: "probe ?" });
  writeRawMarked(service, conn, "?", { source: "probe ?" });
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const first = readFrom(conn, offset);
  let text = first.text;
  // Some devices paginate help output.
  for (let round = 0; round < 4 && MORE_PATTERN.test(tailText(text, 120)); round += 1) {
    writeRawMarked(service, conn, " ", { source: "probe ?" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const more = readFrom(conn, first.next);
    text += more.text;
  }
  // Comware (and IOS) keep the typed prefix on the line after `?`; Ctrl-C and
  // Ctrl-U are ignored by the HCL SSH server, while backspace erases the line.
  // Send enough backspaces, then submit the empty line for a fresh prompt.
  const erase = Math.max(prefix.length + 8, 16);
  writeRawMarked(service, conn, "\b".repeat(erase), { source: "probe ?" });
  await new Promise((resolve) => setTimeout(resolve, 180));
  writeRawMarked(service, conn, "\r", { source: "probe ?" });
  const after = await waitForPrompt(service, conn, { vendor, timeoutMs: 5_000, startedAt: Date.now(), initialOffset: first.next });
  return { text: text + after.text, timedOut: after.timedOut, prompt: after.prompt };
}

/** Clear a partially typed line without executing it. */
export async function abortLine(service, conn, { vendor } = {}) {
  const offset = conn.journal.length;
  writeRawMarked(service, conn, "\u0003", { source: "probe" });
  const result = await waitForPrompt(service, conn, { vendor, timeoutMs: 5_000, startedAt: Date.now(), initialOffset: offset });
  return result;
}

export function cleanCommandOutput(raw, command) {
  let text = stripAnsi(String(raw ?? "")).replace(/\r/g, "").replace(/[\u0000\u0007]/g, "");
  // Drop the echoed command line (the terminal already shows it).
  if (command) {
    const lines = text.split("\n");
    const index = lines.findIndex((line) => line.includes(command));
    if (index >= 0) text = lines.slice(index + 1).join("\n");
  }
  return text.replace(/(?:----\s*More\s*----|--More--)/gi, "").trim();
}