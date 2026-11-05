/**
 * Facade shared by the agent tools and the panel routes.
 *
 * Keeps the Python sidecar, device profiles and plans in one place so both
 * surfaces see exactly the same state.
 */
import { loadRagConfig, saveRagConfig } from "./config.js";
import { RagSidecar } from "./sidecar.js";
import { PlanEngine } from "./plans.js";
import {
  collectDeviceProfile,
  exportDevices,
  getDevice,
  importDevices,
  listDevices,
  removeDevice,
  upsertDevice,
  vendorOptions
} from "./devices.js";
import { listErrorCases } from "./errors.js";

function normalizeVersion(value) {
  let text = String(value ?? "").trim().toUpperCase();
  if (text.startsWith("V")) text = text.slice(1);
  text = text.replace(/\(R\)/g, "");
  return text.replace(/[^0-9A-Z.]/g, ".").replace(/^\.+|\.+$/g, "");
}

function versionTuple(value) {
  return normalizeVersion(value).split(".").map((part) => Number.parseInt(part, 10)).filter((part) => Number.isFinite(part));
}

function compareVersion(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function versionMatches(deviceVersion, entry) {
  if (!deviceVersion || !entry) return false;
  const raw = normalizeVersion(entry.raw ?? entry);
  const device = normalizeVersion(deviceVersion);
  if (raw && (device === raw || device.startsWith(`${raw}.`) || raw.startsWith(`${device}.`))) return true;
  if (entry.min || entry.max) {
    if (entry.min && compareVersion(device, entry.min) < 0) return false;
    if (entry.max && compareVersion(device, entry.max) > 0) return false;
    return true;
  }
  return false;
}

export function matchDocument(doc, profile) {
  if (!doc || !profile) return { status: "unknown", score: 0, reasons: [] };
  const reasons = [];
  let score = 0;
  const vendor = String(profile.vendor ?? "").toLowerCase();
  const docVendor = String(doc.vendor ?? "").toLowerCase();
  if (vendor && docVendor && vendor !== docVendor) return { status: "mismatch", score: -10, reasons: [`vendor ${docVendor} != ${vendor}`] };
  if (vendor && docVendor) {
    score += 1;
    reasons.push("vendor");
  }
  const model = String(profile.model ?? "").toLowerCase();
  const series = [...(doc.series ?? []), ...(doc.models ?? [])].map((item) => String(item).toLowerCase());
  if (model && series.length) {
    if (series.some((item) => item && (item.includes(model) || model.includes(item)))) {
      score += 2;
      reasons.push("model");
    } else {
      reasons.push("model differs");
    }
  }
  if (profile.version && (doc.versions ?? []).length) {
    if (doc.versions.some((entry) => versionMatches(profile.version, entry))) {
      score += 2;
      reasons.push("version");
    } else {
      reasons.push("version differs");
    }
  }
  if (reasons.includes("model differs") || reasons.includes("version differs")) return { status: "partial", score, reasons };
  if (score >= 3) return { status: "exact", score, reasons };
  return { status: "partial", score, reasons };
}

export class RagManager {
  constructor(service, pluginConfig = {}) {
    this.service = service;
    this.pluginConfig = pluginConfig;
    this.config = null;
    this.sidecar = null;
    this.plans = null;
    this.deviceProfiles = new Map();
    this._initPromise = null;
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      this.config = await loadRagConfig(this.pluginConfig);
      this.sidecar = new RagSidecar(this.config);
      this.plans = new PlanEngine(this.service, this.sidecar);
      this.plans.deviceProfiles = this.deviceProfiles;
      return this;
    })();
    return this._initPromise;
  }

  async status() {
    await this.init();
    const sidecar = await this.sidecar.status().catch((error) => ({ running: false, ready: false, error: error.message }));
    let docs = [];
    if (sidecar.ready) {
      try {
        docs = (await this.sidecar.request("/docs")).docs ?? [];
      } catch {}
    }
    return {
      config: { ...this.config },
      sidecar,
      docs,
      vendors: vendorOptions(),
      plans: await this.plans.list().catch(() => []),
      devices: (await listDevices()).length
    };
  }

  async ensure() {
    await this.init();
    await this.sidecar.ensure();
    return this;
  }

  async search(request) {
    await this.ensure();
    return this.sidecar.request("/search", { method: "POST", body: request, timeout: 180_000 });
  }

  async docs() {
    await this.ensure();
    return this.sidecar.request("/docs");
  }

  async buildDoc(docId) {
    await this.ensure();
    return this.sidecar.request(`/docs/${encodeURIComponent(docId)}/build`, { method: "POST" });
  }

  async task(taskId) {
    await this.ensure();
    return this.sidecar.request(`/tasks/${encodeURIComponent(taskId)}`);
  }

  async deleteDoc(docId) {
    await this.ensure();
    return this.sidecar.request(`/docs/${encodeURIComponent(docId)}`, { method: "DELETE" });
  }

  async previewDoc(docId, limit = 12) {
    await this.ensure();
    return this.sidecar.request(`/docs/${encodeURIComponent(docId)}/preview?limit=${limit}`);
  }

  async collect(connectionId, vendorHint = null, { bind = true } = {}) {
    await this.init();
    const conn = this.service.resolveTarget(connectionId);
    const profile = await collectDeviceProfile(this.service, conn, { vendorHint });
    this.deviceProfiles.set(conn.id, profile);
    if (bind) await this.attachBindings(profile);
    return profile;
  }

  async profile(connectionId, { bind = true } = {}) {
    await this.init();
    const conn = this.service.resolveTarget(connectionId);
    const cached = this.deviceProfiles.get(conn.id);
    if (cached) return bind ? this.attachBindings(cached) : cached;
    const stored = await listDevices();
    const match = stored.find((profile) =>
      (profile.host && conn.host && profile.host === conn.host && String(profile.port ?? "") === String(conn.port ?? ""))
      || (conn.hostname && profile.hostname === conn.hostname)
    );
    if (match) {
      this.deviceProfiles.set(conn.id, match);
      return bind ? this.attachBindings(match) : match;
    }
    return null;
  }

  async attachBindings(profile) {
    if (profile.bindings?.length) return profile;
    try {
      const docs = (await this.docs()).docs ?? [];
      profile.bindings = docs
        .map((doc) => ({ docId: doc.docId, title: doc.title, ...matchDocument(doc, profile) }))
        .filter((binding) => binding.status !== "mismatch")
        .sort((left, right) => right.score - left.score)
        .slice(0, 5);
      await upsertDevice(profile);
    } catch {}
    return profile;
  }

  async createPlan(input) {
    await this.init();
    return this.plans.create(input);
  }

  async approvePlan(planId, options = {}) {
    await this.init();
    return this.plans.approve(planId, options);
  }

  async executePlan(planId, options = {}) {
    await this.init();
    return this.plans.execute(planId, options);
  }

  async revisePlan(planId, stepId, step, reason) {
    await this.init();
    return this.plans.revise(planId, stepId, step, reason);
  }

  async diagnosePlan(planId, stepId) {
    await this.init();
    return this.plans.diagnose(planId, stepId);
  }

  async plansList() {
    await this.init();
    return this.plans.list();
  }

  async planGet(planId) {
    await this.init();
    return this.plans.load(planId);
  }

  async devicesList() {
    await this.init();
    return listDevices();
  }

  async deviceGet(deviceId) {
    await this.init();
    return getDevice(deviceId);
  }

  async devicesExport() {
    await this.init();
    return exportDevices();
  }

  async devicesImport(payload) {
    await this.init();
    return importDevices(payload);
  }

  async deviceRemove(deviceId) {
    await this.init();
    return removeDevice(deviceId);
  }

  async errors() {
    await this.init();
    return listErrorCases({ limit: 200 });
  }

  async updateSettings(patch) {
    await this.init();
    const previous = this.config;
    this.config = await saveRagConfig(patch);
    const restart = ["dataDir", "python", "modelPath", "device", "embedder"].some((key) => patch[key] !== undefined && patch[key] !== previous[key]);
    if (restart) {
      await this.sidecar.stop().catch(() => {});
      this.sidecar = new RagSidecar(this.config);
      this.plans.sidecar = this.sidecar;
    }
    return this.status();
  }
}