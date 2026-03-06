function normalizeForCompare(rawPath) {
  let value = String(rawPath || "").trim();
  if (!value) return "";
  value = value.replace(/\\/g, "/");
  value = value.replace(/\/{2,}/g, "/");

  const driveRoot = /^[a-zA-Z]:\/$/;
  while (value.length > 1 && value.endsWith("/") && !driveRoot.test(value)) {
    value = value.slice(0, -1);
  }

  if (/^[a-zA-Z]:/.test(value)) {
    value = `${value[0].toLowerCase()}${value.slice(1)}`;
  }

  return value;
}

function pathDepth(normalizedPath) {
  if (!normalizedPath) return 0;
  return normalizedPath.split("/").filter(Boolean).length;
}

export function prioritizeDroppedPaths(values) {
  const unique = new Map();

  for (const value of values || []) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) continue;
    const normalized = normalizeForCompare(raw);
    if (!normalized) continue;
    if (!unique.has(normalized)) unique.set(normalized, { raw, normalized });
  }

  const rows = Array.from(unique.values());
  if (rows.length <= 1) return rows.map(row => row.raw);

  const filtered = rows.filter(row => {
    const prefix = `${row.normalized}/`;
    return !rows.some(other => other !== row && other.normalized.startsWith(prefix));
  });

  filtered.sort((a, b) => {
    const depthDiff = pathDepth(b.normalized) - pathDepth(a.normalized);
    if (depthDiff !== 0) return depthDiff;
    return b.normalized.length - a.normalized.length;
  });

  return filtered.map(row => row.raw);
}

