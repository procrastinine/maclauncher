function normalizeLoveVersion(input) {
  const raw = String(input || "").trim().replace(/^v/i, "");
  if (!raw) return null;
  const match = raw.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] != null ? Number(match[3]) : null;
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  if (patch == null || !Number.isFinite(patch)) return `${major}.${minor}`;
  if (major > 0 && patch === 0) return `${major}.${minor}`;
  return `${major}.${minor}.${patch}`;
}

function parseLoveVersion(input) {
  const normalized = normalizeLoveVersion(input);
  if (!normalized) return null;
  const parts = normalized.split(".").map(Number);
  if (!parts.every(Number.isFinite)) return null;
  return { normalized, parts };
}

function compareLoveVersions(a, b) {
  const pa = parseLoveVersion(a);
  const pb = parseLoveVersion(b);
  if (!pa || !pb) return String(a || "").localeCompare(String(b || ""));
  const max = Math.max(pa.parts.length, pb.parts.length, 2);
  for (let index = 0; index < max; index += 1) {
    const av = pa.parts[index] || 0;
    const bv = pb.parts[index] || 0;
    if (av !== bv) return av - bv;
  }
  return pa.normalized.localeCompare(pb.normalized);
}

function compareLoveVersionsDesc(a, b) {
  return compareLoveVersions(b, a);
}

function normalizeNightlyBuildKey(input) {
  const value = String(input || "").trim();
  if (!value) return null;
  const cleaned = value.replace(/[^0-9A-Za-z._-]+/g, "_");
  return cleaned || null;
}

function parseNightlyBuildTimestamp(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/);
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function compareNightlyBuildKeys(a, b) {
  const ta = parseNightlyBuildTimestamp(a);
  const tb = parseNightlyBuildTimestamp(b);
  if (ta != null && tb != null && ta !== tb) return ta - tb;
  return String(a || "").localeCompare(String(b || ""));
}

function compareNightlyBuildKeysDesc(a, b) {
  return compareNightlyBuildKeys(b, a);
}

function shortSha(input) {
  const value = String(input || "").trim();
  if (!value) return "";
  return value.slice(0, 7);
}

module.exports = {
  normalizeLoveVersion,
  parseLoveVersion,
  compareLoveVersions,
  compareLoveVersionsDesc,
  normalizeNightlyBuildKey,
  compareNightlyBuildKeys,
  compareNightlyBuildKeysDesc,
  parseNightlyBuildTimestamp,
  shortSha
};
