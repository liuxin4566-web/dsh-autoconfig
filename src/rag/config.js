/**
 * Persistent settings for the embedded RAG service.
 *
 * Defaults live in <home>/.dsh/autoconfig-rag.json so the panel and the tools
 * agree on one location without touching DSH's own configuration.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export const RAG_CONFIG_FILE = join(homedir(), ".dsh", "autoconfig-rag.json");

export const RAG_DEFAULTS = Object.freeze({
  dataDir: join(homedir(), ".dsh", "autoconfig-kb"),
  python: "",
  modelPath: "",
  device: "auto",
  autoStart: true,
  autoCollect: true,
  embedder: "on",
  port: 0
});

function merge(base, extra) {
  const result = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    result[key] = value;
  }
  return result;
}

export async function loadRagConfig(pluginConfig = {}) {
  let stored = {};
  try {
    stored = JSON.parse(await readFile(RAG_CONFIG_FILE, "utf8"));
  } catch {
    stored = {};
  }
  const env = {
    dataDir: process.env.DSH_AUTOCONFIG_KB,
    python: process.env.DSH_AUTOCONFIG_PYTHON,
    modelPath: process.env.DSH_AUTOCONFIG_MODEL
  };
  return merge(merge(RAG_DEFAULTS, stored), merge(pluginConfig, env));
}

export async function saveRagConfig(patch) {
  const current = await loadRagConfig();
  const next = { ...current, ...patch };
  await mkdir(join(homedir(), ".dsh"), { recursive: true });
  await writeFile(RAG_CONFIG_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}