const SCHEMA = require("./schema.json");

function clampNumber(n, min, max) {
  if (!Number.isFinite(n)) return null;
  if (Number.isFinite(min)) n = Math.max(min, n);
  if (Number.isFinite(max)) n = Math.min(max, n);
  return n;
}

const DEFAULT_CHEATS = Object.freeze({ ...(SCHEMA.defaults || {}) });

function normalizeCheats(input) {
  const src = input && typeof input === "object" ? input : {};
  const out = { ...DEFAULT_CHEATS };

  for (const field of SCHEMA.fields || []) {
    const key = field?.key;
    if (!key || !(key in out)) continue;

    if (field.type === "boolean") {
      if (typeof src[key] === "boolean") out[key] = src[key];
      continue;
    }

    if (field.type === "number") {
      const n = clampNumber(Number(src[key]), field.min, field.max);
      if (n != null) out[key] = n;
    }
  }

  return out;
}

function cheatsEqual(a, b) {
  const aa = normalizeCheats(a);
  const bb = normalizeCheats(b);
  for (const k of Object.keys(DEFAULT_CHEATS)) {
    if (aa[k] !== bb[k]) return false;
  }
  return true;
}

module.exports = {
  SCHEMA,
  DEFAULT_CHEATS,
  normalizeCheats,
  cheatsEqual
};

