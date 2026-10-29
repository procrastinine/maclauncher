export const MAX_RUNTIME_CHOICE_LENGTH = 8192;

export function isRuntimeSettingChoiceValue(value) {
  return typeof value === "string" && value.length <= MAX_RUNTIME_CHOICE_LENGTH && !/[\x00-\x1f\x7f]/.test(value);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function resolveRuntimeSettingFallback(field) {
  if (!isRecord(field)) return null;
  if (Object.prototype.hasOwnProperty.call(field, "default")) return field.default;
  const type = typeof field.type === "string" ? field.type : "string";
  if (type === "boolean") return false;
  if (type === "number") return 0;
  if (type === "list") return [];
  return "";
}

export function normalizeListValue(value, separator) {
  if (Array.isArray(value)) return value.map(entry => String(entry ?? "").trim()).filter(entry => entry.length > 0);
  if (typeof value === "string") return value.split(separator === "newline" ? /\r?\n/ : /\r?\n|,/)
    .map(entry => entry.trim()).filter(entry => entry.length > 0);
  return [];
}

export function normalizeRuntimeSettingValue(field, value, fallback) {
  const type = typeof field?.type === "string" ? field.type : "string";
  if (type === "boolean") {
    if (value === true || value === false) return value;
    return fallback === true || fallback === false ? fallback : false;
  }
  if (type === "number") {
    const num = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(num)) return num;
    const fb = typeof fallback === "number" ? fallback : Number(fallback);
    return Number.isFinite(fb) ? fb : 0;
  }
  if (type === "list") return normalizeListValue(value === null || value === undefined ? fallback : value, field.listSeparator);
  const dynamic = typeof field?.optionsAction === "string" && field.optionsAction.trim().length > 0;
  if (type === "select" || dynamic) {
    const values = (Array.isArray(field.options) ? field.options : []).map(opt => opt?.value ?? opt?.id)
      .filter(value => typeof value === "string" && value.length > 0);
    const aliases = Array.isArray(field.legacyValues) ? field.legacyValues : [];
    const migrated = aliases.find(alias => isRecord(alias) && Object.is(alias.value, value));
    if (typeof migrated?.replacement === "string" && values.includes(migrated.replacement)) return migrated.replacement;
    // Local choices can be unavailable while loading or between launches. Keep
    // the exact saved identity; its provider validates availability when used.
    if (dynamic && isRuntimeSettingChoiceValue(value)) return value;
    if (typeof value === "string" && values.includes(value)) return value;
    if (dynamic && isRuntimeSettingChoiceValue(fallback)) return fallback;
    if (typeof fallback === "string" && values.includes(fallback)) return fallback;
    return values[0] || "";
  }
  if (typeof value === "string") return value;
  return typeof fallback === "string" ? fallback : "";
}
