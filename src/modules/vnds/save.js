const MAX_BYTES = 8 * 1024 * 1024;
function validate(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) throw new Error("VNDS save exceeds the 8 MB limit.");
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("VNDS saves contain a JSON object.");
  if (data.interpreter) {
    const state = data.interpreter;
    if (!state || typeof state !== "object" || !/^[^/\\\x00-\x1f]{1,255}\.scr$/i.test(state.file || "") ||
        !Number.isSafeInteger(state.n) || state.n < 1 || state.n > 10000000) throw new Error("VNDS save has an invalid script position.");
    for (const field of ["locals", "globals"]) if (state[field] && (typeof state[field] !== "object" || Array.isArray(state[field]))) throw new Error("VNDS variables must be named JSON values.");
  }
  return text;
}
module.exports = { extensions: ["json"], decode: validate, encode: validate, validate };
