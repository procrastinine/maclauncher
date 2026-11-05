// One version order for automatic choices among usable installations. Digit
// runs compare as numbers. Build hashes identify builds but do not order them.
const HASH = /[-_][a-f0-9]{7,}(?=$|[-_.])/gi;

function orderKey(value) {
  return String(value ?? "").trim().replace(/^v(?=\d)/i, "").replace(HASH, "");
}

export function compareVersions(left, right) {
  const a = orderKey(left), b = orderKey(right), release = /^(\d+(?:\.\d+)+)(.*)$/;
  const aa = release.exec(a), bb = release.exec(b);
  if (aa && bb) {
    const av = aa[1].split("."), bv = bb[1].split(".");
    for (let index = 0; index < Math.max(av.length, bv.length); index++) {
      const compared = (av[index] || "0").localeCompare(bv[index] || "0", undefined, { numeric: true });
      if (compared) return compared;
    }
    const suffixA = aa[2], suffixB = bb[2];
    if (!suffixA || !suffixB) {
      const suffix = suffixA || suffixB;
      if (!suffix) return 0;
      // git-describe counts commits after a release, unlike a dash prerelease.
      const before = suffix.startsWith("-") && !/^-\d+-g[a-f0-9]+$/i.test(suffix);
      return suffixA ? before ? -1 : 1 : before ? 1 : -1;
    }
    return suffixA.localeCompare(suffixB, undefined, { numeric: true, sensitivity: "base" });
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// Publisher metadata orders a catalog; opaque download keys remain identities.
export function catalogVersion(pin = {}) {
  if (pin.projectPackage) return pin.version;
  if (pin.releaseVersion) return pin.releaseVersion;
  try {
    const tag = new URL(pin.sourceUrl).pathname.split("/releases/tag/")[1];
    if (tag) return decodeURIComponent(tag);
  } catch {}
  return pin.upstreamTag || pin.version;
}

/** The item with the newest version. Different versions equal in order, such
 * as builds that differ only by hash, follow `listed`, the cached catalog's
 * version order (newest first): the earlier-listed wins. The result is null
 * when there is no item, or when such a tie includes a version the catalog does
 * not list. Equal versions keep input order. */
export function newest(items, { listed = [], versionOf = item => item.version } = {}) {
  const sorted = [...items].sort((a, b) => compareVersions(versionOf(b), versionOf(a))), top = sorted[0];
  if (top === undefined) return null;
  const tied = sorted.filter(item => compareVersions(versionOf(item), versionOf(top)) === 0);
  if (tied.every(item => versionOf(item) === versionOf(top))) return top;
  const order = Array.from(listed || []), rank = item => order.indexOf(versionOf(item));
  if (tied.some(item => rank(item) < 0)) return null;
  return tied.reduce((best, item) => rank(item) < rank(best) ? item : best);
}
