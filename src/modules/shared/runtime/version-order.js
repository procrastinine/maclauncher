// One version order for automatic choices among usable installations. Digit
// runs compare as numbers. Build hashes identify builds but do not order them.
const HASH = /[-_][a-f0-9]{7,}(?=$|[-_.])/gi;

function orderKey(value) {
  return String(value ?? "").trim().replace(/^v(?=\d)/i, "").replace(HASH, "");
}

function compareVersions(left, right) {
  return orderKey(left).localeCompare(orderKey(right), undefined, { numeric: true, sensitivity: "base" });
}

/** The item with the newest version. Different versions equal in order, such
 * as builds that differ only by hash, follow `listed`, the cached catalog's
 * version order (newest first): the earlier-listed wins. The result is null
 * when there is no item, or when such a tie includes a version the catalog does
 * not list. Equal versions keep input order. */
function newest(items, { listed = [], versionOf = item => item.version } = {}) {
  const sorted = [...items].sort((a, b) => compareVersions(versionOf(b), versionOf(a))), top = sorted[0];
  if (top === undefined) return null;
  const tied = sorted.filter(item => compareVersions(versionOf(item), versionOf(top)) === 0);
  if (tied.every(item => versionOf(item) === versionOf(top))) return top;
  const order = Array.from(listed || []), rank = item => order.indexOf(versionOf(item));
  if (tied.some(item => rank(item) < 0)) return null;
  return tied.reduce((best, item) => rank(item) < rank(best) ? item : best);
}

module.exports = { compareVersions, newest };
