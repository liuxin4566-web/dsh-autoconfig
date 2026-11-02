/**
 * Browser-side client for the `autoconfig` Remote namespace. The namespace
 * service is mounted by apply() through ctx.remote.$mount(TYPERT_REMOTE); this
 * class unwraps the { ok, value | error } envelope into values or thrown errors
 * and converts base64 wire payloads.
 */

export class AutoconfigApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AutoconfigApiError";
    this.code = code;
  }
}

function encodeBase64Bytes(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function decodeBase64Bytes(data) {
  const binary = atob(data ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeBase64Text(data) {
  return new TextDecoder().decode(decodeBase64Bytes(data));
}

function encodeBase64Text(text) {
  return encodeBase64Bytes(new TextEncoder().encode(text));
}

export class AutoconfigApi {
  constructor(getNamespace) {
    this.getNamespace = getNamespace;
  }

  async call(method, args) {
    const namespace = this.getNamespace();
    const fn = namespace?.[method];
    if (typeof fn !== "function") {
      throw new AutoconfigApiError("not-mounted", `autoconfig Remote method "${method}" is not mounted`);
    }
    const rpc = await fn(args);
    if (!rpc || rpc.ok !== true) {
      throw new AutoconfigApiError(rpc?.error?.code ?? "rpc-failed", rpc?.error?.message ?? "remote call failed");
    }
    const business = rpc.value;
    if (!business || typeof business.ok !== "boolean") {
      throw new AutoconfigApiError("bad-envelope", `autoconfig Remote method "${method}" returned an unexpected payload`);
    }
    if (business.ok) return business.value;
    throw new AutoconfigApiError(business.error?.code ?? "rpc-failed", business.error?.message ?? "remote call failed");
  }

  list() { return this.call("list", {}); }
  connect(input) { return this.call("connect", input); }
  // Saved sessions use the plugin's same-origin JSON route rather than a Typert
  // method: DSH caches Typert manifests until the next app start, so a hot
  // reload cannot add a new RPC endpoint.
  async profileRequest(method, body) {
    const response = await fetch("/dsh-autoconfig/profiles", {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store"
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw Object.assign(new Error(`会话服务返回了非 JSON 响应（HTTP ${response.status}）`), { code: "profile-transport" });
    }
    if (payload?.ok !== true) {
      const error = new Error(payload?.error?.message ?? `会话服务请求失败（HTTP ${response.status}）`);
      error.code = payload?.error?.code ?? "profile-failed";
      throw error;
    }
    return payload.value;
  }
  profileSave(input) { return this.profileRequest("POST", { action: "save", ...input }); }
  profileList() { return this.profileRequest("GET"); }
  profileDelete(profileId) { return this.profileRequest("POST", { action: "delete", profileId }); }
  profileConnect(profileId) { return this.profileRequest("POST", { action: "connect", profileId }); }
  select(connectionId) { return this.call("select", { connectionId }); }
  close(connectionId) { return this.call("close", { connectionId }); }
  resize(connectionId, cols, rows) { return this.call("resize", { connectionId, cols, rows }); }
  serialPorts() { return this.call("serialPorts", {}); }

  async write(connectionId, text, { source = "panel", sensitive = false } = {}) {
    return this.call("write", { connectionId, data: encodeBase64Text(text), source, sensitive });
  }

  async read(connectionId, timeoutMs = 300, after) {
    const value = await this.call("read", { connectionId, timeoutMs, ...(after === undefined ? {} : { after }) });
    return {
      data: value.data ? decodeBase64Text(value.data) : "",
      exit: value.exit,
      startOffset: value.startOffset,
      offset: value.offset
    };
  }

  /** Stream push over the Gateway WebSocket mux; null when unavailable. */
  async streamTerminal(connectionId, signal, after) {
    const namespace = this.getNamespace();
    const fn = namespace?.terminalStream;
    if (typeof fn !== "function") return null;
    let stream;
    try {
      const request = { connectionId, ...(after === undefined ? {} : { after }) };
      stream = signal !== undefined ? await fn(request, signal) : await fn(request);
    } catch {
      return null;
    }
    if (stream === null || stream === undefined || typeof stream[Symbol.asyncIterator] !== "function") return null;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const item of stream) {
          if (!item || item.ok !== true) {
            throw new AutoconfigApiError(item?.error?.code ?? "rpc-failed", item?.error?.message ?? "terminal stream failed");
          }
          yield {
            data: item.value.data ? decodeBase64Text(item.value.data) : "",
            exit: item.value.exit,
            startOffset: item.value.startOffset,
            offset: item.value.offset
          };
        }
      }
    };
  }

  sftpList(connectionId, path, quiet = false) {
    return this.call("sftpList", { connectionId, path, quiet: quiet || undefined });
  }
  sftpMkdir(connectionId, path) { return this.call("sftpMkdir", { connectionId, path }); }
  sftpDelete(connectionId, path) { return this.call("sftpDelete", { connectionId, path }); }
  sftpRename(connectionId, from, to) { return this.call("sftpRename", { connectionId, from, to }); }

  async sftpReadFile(connectionId, path, maxBytes) {
    const value = await this.call("sftpReadFile", { connectionId, path, maxBytes });
    return { ...value, bytes: decodeBase64Bytes(value.data) };
  }

  sftpWriteFile(connectionId, path, bytes) {
    return this.call("sftpWriteFile", { connectionId, path, data: encodeBase64Bytes(bytes) });
  }

  logList() { return this.call("logList", {}); }
  logDelete(file) { return this.call("logDelete", { file }); }
  async logRead(file, offset = 0, maxBytes = 65536) {
    const value = await this.call("logRead", { file, offset, maxBytes });
    return { ...value, text: value.data ? decodeBase64Text(value.data) : "" };
  }
}

export function createAutoconfigApi(ctx) {
  return new AutoconfigApi(() => ctx.remote?.namespaces?.get("autoconfig")?.service);
}
