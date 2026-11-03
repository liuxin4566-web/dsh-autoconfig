/**
 * Vendor error parsing and the local pitfall corpus.
 *
 * The caret line is the best signal a CLI gives: the device echoes the command,
 * prints `^` under the offending token, then an error sentence. We map that
 * column back to the token so a repair can change exactly one argument instead
 * of re-sending a guessed command.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { stripAnsi } from "../prompt.js";
import { getVendor } from "./vendors.js";

export const ERROR_FILE = join(homedir(), ".dsh", "autoconfig-errors.jsonl");

const GENERIC_ERRORS = [
  /%\s*(?:Invalid input|Unrecognized command|Incomplete command|Wrong parameter|Too many parameters|Ambiguous command)/i,
  /Error:\s*(?:Unrecognized|Incomplete|Wrong parameter|Too many parameters)/i,
  /%\s*(?:Permission denied|Authorization failed)/i
];

export function findError(raw, vendorId) {
  const text = stripAnsi(String(raw ?? "")).replace(/\r/g, "");
  const lines = text.split("\n");
  const vendor = getVendor(vendorId);
  const patterns = [...(vendor?.errorPatterns ?? []), ...GENERIC_ERRORS];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!patterns.some((pattern) => pattern.test(line))) continue;
    const caretLine = lines[index - 1] ?? "";
    const echoLine = lines[index - 2] ?? "";
    const caretColumn = caretLine.includes("^") ? caretLine.indexOf("^") : -1;
    const candidate = caretColumn >= 0 ? caretLineToken(lines, index, caretColumn) : null;
    return {
      isError: true,
      message: line.trim(),
      line: line.trim(),
      caretColumn,
      caretLine: caretLine.trim(),
      echoLine: echoLine.trim(),
      token: candidate?.token ?? null,
      tokenIndex: candidate?.index ?? -1,
      command: candidate?.command ?? null
    };
  }
  return { isError: false };
}

function caretLineToken(lines, errorIndex, caretColumn) {
  // The caret line sits directly under the echoed command; use that line's
  // absolute column so the prompt prefix is accounted for.
  for (let offset = 2; offset <= 4; offset += 1) {
    const echo = lines[errorIndex - offset];
    if (!echo || echo.trim() === "" || echo.includes("^")) continue;
    if (caretColumn >= echo.length) continue;
    let start = caretColumn;
    while (start > 0 && !/\s/.test(echo[start - 1])) start -= 1;
    let end = caretColumn;
    while (end < echo.length && !/\s/.test(echo[end])) end += 1;
    const token = echo.slice(start, end).trim();
    if (!token) continue;
    return { token, index: start, command: echo.trim() };
  }
  return null;
}

export function classifyOutput(raw, { vendorId, timedOut = false, expectOk = [] } = {}) {
  const error = findError(raw, vendorId);
  if (error.isError) return { status: "failed", error };
  if (timedOut) return { status: "unknown", error: null };
  const text = stripAnsi(String(raw ?? ""));
  for (const pattern of expectOk) {
    if (pattern instanceof RegExp && pattern.test(text)) return { status: "ok", error: null };
  }
  return { status: "ok", error: null };
}

export async function recordErrorCase(entry) {
  await mkdir(join(homedir(), ".dsh"), { recursive: true });
  // Keep a stable key set: a missing field must not become `undefined`, which
  // would make the JSON snapshot of a later plan invalid.
  const record = {
    vendor: "",
    platform: "",
    model: "",
    version: "",
    command: "",
    errorText: "",
    token: "",
    caretColumn: null,
    docId: "",
    planId: "",
    stepId: "",
    fix: "",
    ...entry,
    recordedAt: new Date().toISOString()
  };
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) record[key] = "";
  }
  await appendFile(ERROR_FILE, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function listErrorCases({ vendor, limit = 100 } = {}) {
  let text = "";
  try {
    text = await readFile(ERROR_FILE, "utf8");
  } catch {
    return [];
  }
  const records = text.split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const filtered = vendor ? records.filter((item) => item.vendor === vendor) : records;
  return filtered.slice(-Math.max(1, limit)).reverse();
}

function tokensOf(text) {
  return new Set(String(text ?? "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((token) => token.length >= 2));
}

/** Rank historical pitfalls for a command/query so plan_create can warn early. */
export async function findPitfalls({ vendor, command, query, limit = 3 } = {}) {
  const records = await listErrorCases({ vendor, limit: 500 });
  if (!records.length) return [];
  const wanted = tokensOf(`${command ?? ""} ${query ?? ""}`);
  const scored = records.map((record) => {
    const tokens = tokensOf(`${record.command ?? ""} ${record.errorText ?? ""} ${record.token ?? ""}`);
    let overlap = 0;
    for (const token of wanted) if (tokens.has(token)) overlap += 1;
    return { record, score: overlap };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score);
  return scored.slice(0, limit).map(({ record, score }) => ({
    score,
    vendor: record.vendor ?? "",
    model: record.model ?? "",
    version: record.version ?? "",
    command: record.command ?? "",
    token: record.token ?? "",
    errorText: record.errorText ?? "",
    fix: record.fix ?? "",
    docId: record.docId ?? ""
  }));
}