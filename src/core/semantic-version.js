// Semantic versions as defined at semver.org: MacLauncher's package version,
// its release tags (v<version>) and app.getVersion(). Build metadata after
// "+" does not affect order.
const PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** The parsed version, or null for text that is not a semantic version. */
function parse(value) {
  if (value && typeof value === "object" && Array.isArray(value.core) && Array.isArray(value.pre)) return value;
  const match = typeof value === "string" && PATTERN.exec(value);
  if (!match || (match[4] || "").split(".").some(id => /^0\d+$/.test(id))) return null;
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split(".") || [] };
}

/** -1, 0 or 1. Each side is a version string or a parse() result. */
function compare(left, right) {
  const a = parse(left), b = parse(right);
  if (!a || !b) throw new TypeError("Only semantic versions can be compared.");
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

module.exports = { parse, compare };
