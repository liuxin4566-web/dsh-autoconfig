/** Browser client for the plugin's same-origin RAG routes. */

async function parseResponse(response) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`RAG 服务返回了非 JSON 响应（HTTP ${response.status}）`), { code: "rag-transport" });
  }
  if (payload?.ok !== true) {
    const error = new Error(payload?.error?.message ?? `RAG 请求失败（HTTP ${response.status}）`);
    error.code = payload?.error?.code ?? "rag-failed";
    error.details = payload?.error?.details ?? null;
    throw error;
  }
  return payload.value;
}

export async function ragRequest(action, body = {}) {
  const response = await fetch("/dsh-autoconfig/rag", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...body }),
    cache: "no-store"
  });
  return parseResponse(response);
}

export async function ragUpload(formData) {
  const response = await fetch("/dsh-autoconfig/rag-upload", {
    method: "POST",
    body: formData,
    cache: "no-store"
  });
  return parseResponse(response);
}