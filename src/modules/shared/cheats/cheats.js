function clampNumber(n, min, max) {
  if (!Number.isFinite(n)) return null;
  if (Number.isFinite(min)) n = Math.max(min, n);
  if (Number.isFinite(max)) n = Math.min(max, n);
  return n;
}

function createCheatsHelpers(schema) {
  const resolvedSchema = schema && typeof schema === "object" ? schema : {};
  const defaults = Object.freeze({ ...(resolvedSchema.defaults || {}) });
  const fields = Array.isArray(resolvedSchema.fields) ? resolvedSchema.fields : [];

  function normalizeCheats(input) {
    const src = input && typeof input === "object" ? input : {};
    const out = { ...defaults };

    for (const field of fields) {
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
    for (const k of Object.keys(defaults)) {
      if (aa[k] !== bb[k]) return false;
    }
    return true;
  }

  return {
    schema: resolvedSchema,
    defaults,
    normalizeCheats,
    cheatsEqual
  };
}

module.exports = {
  createCheatsHelpers
};
