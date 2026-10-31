const path = require("node:path");
const Upstream = require("../../shared/runtime/upstream");
const { MAX_CATALOG_ENTRIES } = require("../../shared/runtime/runtime-catalog");
const { VERSION } = require("../detect");

const API = "https://services.api.unity.com/unity/editor/release/v1/releases";
const SOURCE = "https://unity.com/releases/editor/archive";
const MAX_PAGE_SIZE = 25;
const HOSTS = ["unity.com", "unity3d.com"];

function pageUrl({ version, offset = 0 } = {}) {
  const query = new URLSearchParams({ limit: String(MAX_PAGE_SIZE), offset: String(offset), order: "RELEASE_DATE_DESC" });
  if (version) query.set("version", version);
  return `${API}?${query}`;
}

// One page of Unity's release API. A page that answers another offset, or is
// empty although more releases remain, is rejected so the cached list stays.
// A missing total, a smaller page or extra results are read as published.
function readPage(document, offset) {
  if (!document || document.status !== 200) throw new Error(`Unity release lookup failed (HTTP ${document?.status ?? "unavailable"}).`);
  const data = JSON.parse(document.text);
  const total = Number.isSafeInteger(data?.total) && data.total >= 0 ? data.total : null;
  if (!Array.isArray(data?.results) || data.total !== undefined && total === null || data.offset !== undefined && data.offset !== offset ||
      !data.results.length && (total === null ? offset === 0 : offset < total)) throw new Error("Unity release metadata is invalid.");
  return { total, results: data.results.slice(0, MAX_PAGE_SIZE) };
}
// The next offset follows the releases actually read; the API may answer a smaller page.
function nextOffset(page, offset) {
  const read = page.results.length;
  return !read || page.total !== null && offset + read >= page.total || page.total === null && read < MAX_PAGE_SIZE ? null : offset + read;
}

// The Mac Mono player component of one release: `mac-mono`, or `mac` for
// Unity 2017 and earlier. The installer keeps the current name first, and a
// renamed installer for the same component is read too. Unity's SRI-style
// integrity (`md5-…` or `sha256-…`) is the publisher's digest.
function releaseRow(release) {
  if (!release || !VERSION.test(release.version || "") || !/^[a-f0-9]{12,40}$/.test(release.shortRevision || "") || !Array.isArray(release.downloads)) return null;
  const modules = release.downloads.flatMap(download => Array.isArray(download?.modules)
    ? download.modules.filter(module => module && typeof module === "object").map(module => ({ ...module, platform: download.platform })) : []);
  const legacy = Number(release.version.split(".")[0]) <= 2017;
  const name = module => { try { return path.posix.basename(new URL(module.url).pathname); } catch { return ""; } };
  const exact = module => name(module) === `UnitySetup-Mac-${module.id === "mac" ? "" : "Mono-"}Support-for-Editor-${release.version}.pkg`;
  const module = modules.filter(item => (item.id === "mac-mono" || legacy && item.id === "mac") && String(item.type).toUpperCase() === "PKG" && /\.pkg$/i.test(name(item)))
    .sort((a, b) => Number(exact(b)) - Number(exact(a)) || Number(b.platform === "LINUX") - Number(a.platform === "LINUX"))[0];
  if (!module) return null;
  const integrity = /^(md5|sha1|sha256|sha512)-(.+)$/i.exec(module.integrity || "");
  return { version: release.version, revision: release.shortRevision, sourceUrl: `https://unity.com/releases/editor/whats-new/${release.version}`,
    publishedAt: release.releaseDate || null,
    details: { sourceKind: "release", scriptingBackend: "mono", securityLabel: release.label?.labelText || null },
    files: [{ name: name(module), url: module.url, ...(module.downloadSize?.unit === "BYTE" ? { bytes: module.downloadSize.value } : {}),
      ...(integrity ? { digest: { algorithm: integrity[1].toLowerCase(), value: integrity[2] } } : {}) }] };
}

// Pages through the whole history, or through the search for one exact
// version, up to the shared catalog bound. When the API states its total,
// the next pages are read together at the size it answered; a short page
// ends that group and paging continues from what it actually returned.
const PAGES_AT_ONCE = 4;
function releaseSource(version) {
  return Upstream.index({ locations: [pageUrl({ version })], hosts: HOSTS, parse: async ([first], { fetch: readNext }) => {
    const rows = [], seen = new Set();
    // A release that cannot be read is skipped; the others stay listed.
    const add = ({ results }) => results.forEach(release => {
      if (version && release?.version !== version) return;
      let row = null;
      try { row = releaseRow(release); } catch {}
      if (row && !seen.has(row.version)) { seen.add(row.version); rows.push(row); }
    });
    let offset = 0, page = readPage(first, 0);
    for (;;) {
      add(page);
      if (version && rows.length) break;
      const next = nextOffset(page, offset), stride = page.results.length;
      if (next === null || next >= MAX_CATALOG_ENTRIES) break;
      const offsets = Array.from({ length: version || page.total === null ? 1 : PAGES_AT_ONCE }, (_, index) => next + index * stride)
        .filter(value => value < MAX_CATALOG_ENTRIES && (page.total === null || value < page.total));
      const pages = await Promise.all(offsets.map(async value => readPage(await readNext(pageUrl({ version, offset: value })), value)));
      let used = 0;
      while (used < pages.length - 1 && pages[used].results.length === stride) used += 1;
      pages.slice(0, used).forEach(add);
      offset = offsets[used]; page = pages[used];
    }
    return rows.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  } });
}

// Recent editor releases with a Mac Mono player component. Older exact
// versions resolve on Play through their own search.
const source = releaseSource(null);

async function discoverVersion(version, options = {}) {
  if (!VERSION.test(version || "")) throw new Error("Invalid exact Unity version.");
  // Unity's version filter is full-text search, not an equality guarantee.
  const row = (await releaseSource(version).discover(options)).find(item => item.version === version && item.files.length);
  if (!row) throw new Error(`Unity ${version} has no published Mac Mono player component. Import a matching Mac player in Runtimes.`);
  return row;
}

module.exports = { API, SOURCE, MAX_PAGE_SIZE, source, releaseRow, discoverVersion };
