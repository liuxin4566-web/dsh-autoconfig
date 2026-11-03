/**
 * Same-origin JSON routes for the panel.
 *
 * Typert manifests are cached until the next application start, so new RPC
 * methods would not appear after a hot reload. The panel therefore uses these
 * small HTTP routes (the same pattern the saved-session bar already uses).
 */
import { RAG_CONFIG_FILE } from "./config.js";

const API_PATH = "/dsh-autoconfig/rag";
const UPLOAD_PATH = "/dsh-autoconfig/rag-upload";
const MAX_BODY = 2 * 1024 * 1024;

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin === "") return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY) {
      const error = new Error("request body exceeds 2 MB");
      error.code = "payload-too-large";
      throw error;
    }
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("request body is not JSON");
    error.code = "bad-json";
    throw error;
  }
}

export function registerRagRoutes(hostCtx, manager) {
  hostCtx.effect(() => hostCtx.webServer.register({
    kind: "exact",
    path: API_PATH,
    handler: (request, response) => handleApi(request, response, manager)
  }), "dsh-autoconfig: rag api route");

  hostCtx.effect(() => hostCtx.webServer.register({
    kind: "exact",
    path: UPLOAD_PATH,
    handler: async (request, response) => {
      if (!sameOrigin(request)) {
        sendJson(response, 403, { ok: false, error: { code: "forbidden", message: "same-origin request required" } });
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" });
        response.end();
        return;
      }
      try {
        await manager.ensure();
        manager.sidecar.proxyUpload(request, response);
      } catch (error) {
        sendJson(response, 503, { ok: false, error: { code: error.code ?? "rag-upload-failed", message: error.message } });
      }
    }
  }), "dsh-autoconfig: rag upload route");
}

async function handleApi(request, response, manager) {
  if (!sameOrigin(request)) {
    sendJson(response, 403, { ok: false, error: { code: "forbidden", message: "same-origin request required" } });
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" });
    response.end();
    return;
  }
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    sendJson(response, error.code === "payload-too-large" ? 413 : 400, {
      ok: false,
      error: { code: error.code ?? "bad-request", message: error.message }
    });
    return;
  }
  const action = String(body.action ?? "");
  try {
    const value = await dispatch(action, body, manager);
    sendJson(response, 200, { ok: true, value });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: { code: error.code ?? "rag-api-failed", message: error.message, details: error.details ?? null }
    });
  }
}

async function dispatch(action, body, manager) {
  switch (action) {
    case "status":
      return manager.status();
    case "start":
      await manager.ensure();
      return manager.status();
    case "settings.get":
      return { config: manager.config, file: RAG_CONFIG_FILE };
    case "settings.update":
      return manager.updateSettings(body.patch ?? {});
    case "docs.list":
      return manager.docs();
    case "docs.build":
      return manager.buildDoc(String(body.docId ?? ""));
    case "docs.delete":
      return manager.deleteDoc(String(body.docId ?? ""));
    case "docs.preview":
      return manager.previewDoc(String(body.docId ?? ""), Number(body.limit ?? 12));
    case "task.get":
      return manager.task(String(body.taskId ?? ""));
    case "search":
      return manager.search(body.request ?? { query: body.query ?? "" });
    case "devices.list":
      return manager.devicesList();
    case "devices.get":
      return manager.deviceGet(String(body.deviceId ?? ""));
    case "devices.collect":
      return manager.collect(body.connectionId, body.vendor ?? null);
    case "devices.export":
      return manager.devicesExport();
    case "devices.import":
      return manager.devicesImport(body.payload ?? body);
    case "devices.remove":
      return manager.deviceRemove(String(body.deviceId ?? ""));
    case "plans.list":
      return manager.plansList();
    case "plans.get":
      return manager.planGet(String(body.planId ?? ""));
    case "plans.approve":
      return manager.approvePlan(String(body.planId ?? ""));
    case "plans.revoke":
      return manager.plans.revoke(String(body.planId ?? ""));
    case "plans.execute":
      return manager.executePlan(String(body.planId ?? ""), { resume: body.resume === true });
    case "plans.resume":
      return manager.plans.resume(String(body.planId ?? ""));
    case "plans.pause":
      return manager.plans.pause(String(body.planId ?? ""));
    case "plans.abort":
      return manager.plans.abort(String(body.planId ?? ""));
    case "plans.diagnose":
      return manager.diagnosePlan(String(body.planId ?? ""), String(body.stepId ?? ""));
    case "errors.list":
      return manager.errors();
    case "vendors.list":
      return manager.status().then((status) => status.vendors);
    case "shutdown":
      await manager.sidecar.stop();
      return { stopped: true };
    default:
      throw Object.assign(new Error(`unknown action: ${action}`), { code: "bad-action" });
  }
}