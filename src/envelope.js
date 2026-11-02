/** Small helpers for the `{ ok, value | error }` service envelope. */

export function ok(value) {
  return { ok: true, value };
}

export function fail(code, message) {
  return { ok: false, error: { code: String(code), message: String(message) } };
}

/** Convert an unknown thrown value into a service failure. */
export function failFrom(error, code = "internal") {
  return fail(error?.code ?? code, error?.message ?? String(error));
}
