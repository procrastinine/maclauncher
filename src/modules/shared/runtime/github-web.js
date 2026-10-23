const { decodeResponseBody } = require("./download-utils");
const decode = value => String(value || "").replace(/&(?:amp|quot|apos|lt|gt|#39|#x[0-9a-f]+|#\d+);/gi, item => {
  const named = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&#39;": "'" };
  if (named[item.toLowerCase()]) return named[item.toLowerCase()];
  const hex = /^&#x([0-9a-f]+);$/i.exec(item), decimal = /^&#(\d+);$/.exec(item), n = parseInt(hex?.[1] || decimal?.[1], hex ? 16 : 10);
  return Number.isSafeInteger(n) && n <= 0x10ffff ? String.fromCodePoint(n) : item;
});
function text(html) {
  return decode(String(html || "").replace(/<a\b([^>]*href=["'][^"']*\/commit\/([a-f0-9]{40})[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi, (all, attributes, sha, label) => {
    const short = label.replace(/<[^>]*>/g, "").trim(); return /^[a-f0-9]{7,39}$/i.test(short) && sha.startsWith(short) ? sha : label;
  }).replace(/<(?:br\b[^>]*|\/(?:p|h[1-6]|li|pre|div))>/gi, "\n").replace(/<[^>]*>/g, "")).replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n").trim();
}
const attribute = (html, name) => decode(new RegExp('\\b' + name + '=["\']([^"\']*)["\']', 'i').exec(html)?.[1] || "");
function parseRefs(body) {
  const buffer = Buffer.from(body), refs = new Map(); let offset = 0;
  while (offset + 4 <= buffer.length) {
    const number = buffer.subarray(offset, offset + 4).toString("ascii");
    if (!/^[a-f0-9]{4}$/i.test(number)) throw new Error("GitHub Git reference advertisement is invalid.");
    const length = parseInt(number, 16); offset += 4;
    if (length === 0) continue;
    if (length < 4 || offset + length - 4 > buffer.length) throw new Error("GitHub Git reference advertisement is truncated.");
    const line = buffer.subarray(offset, offset + length - 4).toString("utf8").split("\0")[0].trim(); offset += length - 4;
    const match = /^([a-f0-9]{40}) (HEAD|refs\/(?:heads|tags)\/[^\s]+)$/i.exec(line);
    if (match) refs.set(match[2], match[1].toLowerCase());
  }
  if (offset !== buffer.length) throw new Error("GitHub Git reference advertisement is truncated.");
  return refs;
}
function parseAssets(html, { owner, repo, tag }) {
  const prefix = `/${owner}/${repo}/releases/download/`, assets = [];
  for (const match of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const block = match[1], links = [...block.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)];
    const href = links.map(link => decode(link[1])).find(value => value.startsWith(prefix)); if (!href) continue;
    const rest = href.slice(prefix.length), split = rest.lastIndexOf("/");
    if (split < 0 || decodeURIComponent(rest.slice(0, split)) !== tag) continue;
    const name = decodeURIComponent(rest.slice(split + 1));
    if (!name || /[\\/\0]/.test(name)) throw new Error("GitHub release asset filename is invalid.");
    const digest = /(?:value=["']|>)(sha256:[a-f0-9]{64})(?:["']|<)/i.exec(block)?.[1]?.toLowerCase() || null;
    assets.push({ name, browser_download_url: "https://github.com" + href, digest, state: "uploaded" });
  }
  return assets;
}
function parseReleases(html, { owner, repo }) {
  const rows = [];
  for (const match of html.matchAll(/<section\b[^>]*data-release-anchor=["'][^"']+["'][^>]*>([\s\S]*?)<\/section>/gi)) {
    const block = match[1], fragment = /<include-fragment\b[^>]*src=["']([^"']+\/releases\/expanded_assets\/[^"']+)["']/i.exec(block)?.[1];
    if (!fragment) continue;
    const url = new URL(decode(fragment), "https://github.com"), prefix = `/${owner}/${repo}/releases/expanded_assets/`;
    if (url.origin !== "https://github.com" || !url.pathname.startsWith(prefix)) throw new Error("GitHub release metadata escaped its repository.");
    const tag = decodeURIComponent(url.pathname.slice(prefix.length));
    const body = /<div\b[^>]*data-test-selector=["']body-content["'][^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] || "";
    const date = /<relative-time\b[^>]*datetime=["']([^"']+)["']/i.exec(block)?.[1] || null;
    const label = text(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block)?.[1] || tag);
    rows.push({ tag_name: tag, name: label, body: text(body), html_url: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tag)}`,
      draft: false, prerelease: /(?:Pre-release|Pre release)<\//i.test(block), published_at: date, created_at: date, assets: [], expanded_assets: url.href });
  }
  return rows;
}
function parseAtom(xml, { owner, repo, releases = false }) {
  return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].flatMap(match => {
    const block = match[1], link = /<link\b[^>]*href=["']([^"']+)["']/i.exec(block)?.[1], date = /<updated>([^<]+)<\/updated>/i.exec(block)?.[1];
    if (!link) return []; const url = new URL(decode(link), "https://github.com"), prefix = `/${owner}/${repo}/${releases ? "releases/tag/" : "commit/"}`;
    if (url.origin !== "https://github.com" || !url.pathname.startsWith(prefix)) throw new Error("GitHub feed escaped its repository.");
    const value = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!releases) return /^[a-f0-9]{40}$/i.test(value) && Number.isFinite(Date.parse(date)) ? [{ sha: value.toLowerCase(), html_url: url.href,
      commit: { message: text(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(block)?.[1] || ""), committer: { date }, author: { date } } }] : [];
    return [{ tag_name: value, name: text(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(block)?.[1] || value), body: text(decode(/<content[^>]*>([\s\S]*?)<\/content>/i.exec(block)?.[1] || "")),
      html_url: url.href, draft: false, prerelease: false, published_at: date, created_at: date, assets: [], expanded_assets: `https://github.com/${owner}/${repo}/releases/expanded_assets/${encodeURIComponent(value)}` }];
  });
}
function createWebFallback(read) {
  const body = response => decodeResponseBody(response.body, response.headers, { maxBytes: 16 * 1024 * 1024 }).toString("utf8");
  const json = (value, headers = {}) => ({ status: 200, headers: { "content-type": "application/json", ...headers }, body: Buffer.from(JSON.stringify(value)) });
  async function checked(url, options) { const result = await read(url, options); if (result.status !== 200) throw new Error(`Public GitHub metadata is unavailable (${result.status}).`); return result; }
  async function repositoryRefs(owner, repo, options) {
    return parseRefs((await checked(`https://github.com/${owner}/${repo}.git/info/refs?service=git-upload-pack`, options)).body);
  }
  return async function fallback(url, options = {}) {
    const parsed = new URL(url), match = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(.+)$/.exec(parsed.pathname);
    if (!match) return null; const [, owner, repo, route] = match, repository = `https://github.com/${owner}/${repo}`;
    if (route === "tags" || route.startsWith("git/ref/tags/") || route.startsWith("git/tags/")) {
      const advertised = await repositoryRefs(owner, repo, options);
      if (route === "tags") {
        const perPage = Math.min(100, Number(parsed.searchParams.get("per_page")) || 100), page = Number(parsed.searchParams.get("page")) || 1;
        const tags = [...advertised].filter(([name]) => name.startsWith("refs/tags/") && !name.endsWith("^{}")).map(([name, sha]) => ({ name: name.slice(10), commit: { sha: advertised.get(name + "^{}") || sha } })).reverse();
        return json(tags.slice((page - 1) * perPage, page * perPage));
      }
      const ref = route.startsWith("git/ref/tags/") ? "refs/tags/" + decodeURIComponent(route.slice(13)) : [...advertised].find(([name, sha]) => name.startsWith("refs/tags/") && !name.endsWith("^{}") && sha === route.slice(9))?.[0];
      const sha = advertised.get(ref + "^{}") || advertised.get(ref); if (!sha) throw new Error("The GitHub tag has no exact public commit.");
      return json({ object: { sha, type: "commit" } });
    }
    if (route === "commits" || route.startsWith("commits/")) {
      const ref = route === "commits" ? parsed.searchParams.get("sha") : decodeURIComponent(route.slice(8));
      const feed = repository + (ref ? "/commits/" + encodeURIComponent(ref) + ".atom" : "/commits.atom");
      const commits = parseAtom(body(await checked(feed, options)), { owner, repo });
      if (route === "commits") return json(commits.slice(0, Number(parsed.searchParams.get("per_page")) || 20));
      if (!commits[0] || /^[a-f0-9]{40}$/i.test(ref) && commits[0].sha !== ref.toLowerCase()) throw new Error("The GitHub commit has no exact public identity.");
      return json(commits[0]);
    }
    if (route.startsWith("contents/") && /^[a-f0-9]{40}$/i.test(parsed.searchParams.get("ref") || "")) {
      const result = await checked(`https://raw.githubusercontent.com/${owner}/${repo}/${parsed.searchParams.get("ref")}/${route.slice(9)}`, options);
      return json({ type: "file", encoding: "base64", content: decodeResponseBody(result.body, result.headers).toString("base64") });
    }
    if (route === "releases" || route.startsWith("releases/tags/") || route === "releases/latest") {
      const page = Math.max(1, Number(parsed.searchParams.get("page")) || 1), selected = route.startsWith("releases/tags/") ? decodeURIComponent(route.slice(14)) : null;
      const response = await checked(repository + "/releases" + (selected ? "/tag/" + encodeURIComponent(selected) : route === "releases/latest" ? "/latest" : "?page=" + page), options), html = body(response);
      let releases = parseReleases(html, { owner, repo });
      if (!releases.length) releases = parseAtom(body(await checked(repository + "/releases.atom", options)), { owner, repo, releases: true });
      if (selected) releases = releases.filter(release => release.tag_name === selected);
      for (const release of releases) {
        const assets = parseAssets(body(await checked(release.expanded_assets, options)), { owner, repo, tag: release.tag_name }); delete release.expanded_assets;
        if (assets.length > 500) throw new Error("GitHub release asset list exceeds its limit.");
        if (!options.deferAssetSizes) {
          let nextAsset = 0;
          await Promise.all(Array.from({ length: Math.min(6, assets.length) }, async () => {
            while (nextAsset < assets.length) {
              const asset = assets[nextAsset++], head = await read(asset.browser_download_url, { ...options, method: "HEAD", assetDigest: asset.digest });
              const size = Number(head.headers?.["content-length"]);
              if (head.status !== 200 || !Number.isSafeInteger(size) || size < 1) throw new Error("GitHub release asset has no exact public size.");
              asset.size = size;
            }
          }));
        }
        release.assets = assets;
      }
      if (route !== "releases") { if (!releases[0]) throw new Error("The GitHub release is unavailable."); return json(releases[0]); }
      const next = /<a\b[^>]*(?:rel=["']next["']|class=["'][^"']*next_page)[^>]*>/i.test(html);
      return json(releases, { "x-maclauncher-github-web": "1", ...(next ? { link: `<https://api.github.com/repos/${owner}/${repo}/releases?per_page=100&page=${page + 1}>; rel="next"` } : {}) });
    }
    return null;
  };
}
module.exports = { createWebFallback, parseRefs, parseAssets, parseReleases, parseAtom, text };
