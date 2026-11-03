/**
 * Lifecycle and HTTP client for the Python BookRAG sidecar.
 *
 * The sidecar binds 127.0.0.1 on an ephemeral port and accepts only the random
 * bearer token generated for this process. The browser never talks to it
 * directly; the plugin proxies the few UI routes that need uploads.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const READY_TIMEOUT_MS = 90_000;

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await readFile(path);
      return path;
    } catch {}
  }
  return null;
}

export class RagSidecar {
  constructor(config) {
    this.config = config;
    this.token = randomUUID();
    this.proc = null;
    this.port = null;
    this.ready = null;
    this.starting = null;
    this.logStream = null;
    this.lastError = null;
    this.stopping = false;
  }

  get dataDir() {
    return this.config.dataDir;
  }

  async sidecarRoot() {
    const candidates = [
      join(HERE, "..", "sidecar"),
      join(HERE, "..", "..", "sidecar"),
      join(HERE, "sidecar")
    ];
    for (const candidate of candidates) {
      const found = await firstExisting([join(candidate, "bookrag_svc", "__main__.py")]);
      if (found) return candidate;
    }
    return null;
  }

  async pythonPath() {
    if (this.config.python) return this.config.python;
    const candidates = process.platform === "win32"
      ? [join(this.dataDir, ".venv", "Scripts", "python.exe")]
      : [join(this.dataDir, ".venv", "bin", "python")];
    return (await firstExisting(candidates)) ?? null;
  }

  async status() {
    if (!this.proc || !this.port) return { running: false, port: null, ready: false, error: this.lastError };
    try {
      const health = await this.request("/health", { timeout: 5_000 });
      return { running: true, port: this.port, ready: true, health, error: null };
    } catch (error) {
      return { running: true, port: this.port, ready: false, error: error.message };
    }
  }

  async start() {
    if (this.port && this.proc) return this.status();
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async _start() {
    const root = await this.sidecarRoot();
    if (!root) {
      const error = new Error("插件缺少 sidecar/bookrag_svc，无法启动本地检索服务。");
      error.code = "rag-sidecar-missing";
      this.lastError = error.message;
      throw error;
    }
    const python = await this.pythonPath();
    if (!python) {
      const error = new Error(
        `未找到 Python 运行环境。请在 ${join(this.dataDir, ".venv")} 创建 venv 并安装 sidecar/requirements.txt，或在 ~/.dsh/autoconfig-rag.json 中设置 python 路径。`
      );
      error.code = "rag-python-missing";
      this.lastError = error.message;
      throw error;
    }
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(join(this.dataDir, "logs"), { recursive: true });
    this.logStream = createWriteStream(join(this.dataDir, "logs", "sidecar.log"), { flags: "a" });

    const args = [
      "-m", "bookrag_svc",
      "--data-dir", this.dataDir,
      "--token", this.token,
      "--port", "0"
    ];
    if (this.config.modelPath) args.push("--model", this.config.modelPath);
    if (this.config.device) args.push("--device", this.config.device);
    if (this.config.embedder === "off") args.push("--embedder", "off");

    const proc = spawn(python, args, {
      cwd: this.dataDir,
      env: {
        ...process.env,
        PYTHONPATH: root,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8"
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.proc = proc;
    proc.stderr.on("data", (chunk) => {
      this.logStream?.write(chunk);
      const text = chunk.toString("utf8");
      if (text.trim()) this.lastError = text.trim().slice(-500);
    });
    proc.on("exit", (code, signal) => {
      this.proc = null;
      this.port = null;
      this.ready = null;
      if (!this.stopping && code !== 0) {
        this.lastError = `sidecar exited (code=${code ?? "null"}${signal ? `, signal=${signal}` : ""})`;
      }
    });

    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`sidecar 启动超时（${Math.round(READY_TIMEOUT_MS / 1000)}s）。${this.lastError ?? ""}`));
      }, READY_TIMEOUT_MS);
      timer.unref?.();
      proc.stdout.on("data", (chunk) => {
        this.logStream?.write(chunk);
        buffer += chunk.toString("utf8");
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          try {
            const payload = JSON.parse(line);
            if (payload?.event === "ready" && Number.isInteger(payload.port)) {
              this.port = payload.port;
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(payload);
            }
          } catch {}
        }
      });
      proc.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      proc.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`sidecar 启动失败（exit ${code}）。${this.lastError ?? ""}`));
      });
    });
    await this.ready;
    await this._waitHealthy();
    return this.status();
  }

  async _waitHealthy() {
    // The ready line is printed before uvicorn binds; wait for the listener so
    // the first /docs call cannot race the socket.
    const deadline = Date.now() + 30_000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        await this.request("/health", { timeout: 2_000 });
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error(`sidecar 已打印 ready 但端口未就绪：${lastError?.message ?? "unknown"}`);
  }

  async ensure() {
    if (this.config.autoStart === false) {
      const error = new Error("RAG 服务未启动（autoStart=false）。");
      error.code = "rag-not-started";
      throw error;
    }
    if (!this.port) await this.start();
    return this;
  }

  request(path, { method = "GET", body, headers = {}, timeout = 60_000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.port) {
        reject(Object.assign(new Error("RAG sidecar is not running"), { code: "rag-not-running" }));
        return;
      }
      const payload = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
      const request = http.request(
        {
          host: "127.0.0.1",
          port: this.port,
          path,
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
            ...headers
          },
          timeout
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              parsed = { raw: text };
            }
            if (response.statusCode >= 200 && response.statusCode < 300) {
              resolve(parsed);
            } else {
              const message = parsed?.detail ?? parsed?.error ?? text ?? `HTTP ${response.statusCode}`;
              reject(Object.assign(new Error(typeof message === "string" ? message : JSON.stringify(message)), {
                code: "rag-http",
                status: response.statusCode
              }));
            }
          });
        }
      );
      request.on("timeout", () => request.destroy(new Error(`RAG request timed out: ${path}`)));
      request.on("error", reject);
      if (payload) request.write(payload);
      request.end();
    });
  }

  /** Proxy a browser multipart upload to the sidecar without parsing it here. */
  proxyUpload(request, response) {
    if (!this.port) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: { code: "rag-not-running", message: "RAG sidecar is not running" } }));
      return;
    }
    const headers = { ...request.headers, host: `127.0.0.1:${this.port}`, authorization: `Bearer ${this.token}` };
    delete headers.connection;
    const upstream = http.request(
      { host: "127.0.0.1", port: this.port, path: "/docs", method: "POST", headers, timeout: 15 * 60_000 },
      (result) => {
        response.writeHead(result.statusCode ?? 502, result.headers);
        result.pipe(response);
      }
    );
    upstream.on("timeout", () => upstream.destroy(new Error("upload timed out")));
    upstream.on("error", (error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: { code: "rag-upload-failed", message: error.message } }));
    });
    request.pipe(upstream);
  }

  async stop() {
    this.stopping = true;
    const proc = this.proc;
    try {
      if (this.port) await this.request("/shutdown", { method: "POST", timeout: 2_000 });
    } catch {}
    try {
      proc?.kill();
    } catch {}
    this.proc = null;
    this.port = null;
    this.ready = null;
    try {
      this.logStream?.end();
    } catch {}
    this.logStream = null;
    this.stopping = false;
  }
}