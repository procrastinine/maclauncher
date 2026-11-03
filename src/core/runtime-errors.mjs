// Errors can contain authenticated proxy URLs. Keep the address useful without
// retaining URL user information in UI state, catalog caches or displayed text.
export function sanitizeErrorMessage(error) {
  const message = error instanceof Error ? String(error)
    : error && typeof error === "object" && typeof error.message === "string" ? error.message : String(error);
  return message.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1");
}

export function sanitizeRuntimeErrors(input) {
  const regular = new WeakMap(), errors = new WeakMap();
  function visit(value, errorField = false) {
    if (typeof value === "string") return errorField ? sanitizeErrorMessage(value) : value;
    if (!value || typeof value !== "object") return value;
    if (value instanceof Error) return sanitizeErrorMessage(value);
    const seen = errorField ? errors : regular;
    if (seen.has(value)) return seen.get(value);
    const result = Array.isArray(value) ? [] : {};
    seen.set(value, result);
    for (const [key, item] of Object.entries(value))
      Object.defineProperty(result, key, { value: visit(item, errorField || key === "error" || key === "installReason"),
        enumerable: true, writable: true, configurable: true });
    return result;
  }
  return visit(input);
}
