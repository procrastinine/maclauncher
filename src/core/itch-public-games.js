const crypto = require("node:crypto");
const path = require("node:path");

const publicError = message => Object.assign(new Error(message), { itchPublic: true });
const accessError = () => publicError("This itch.io download requires purchase or account access. Use an API key for owned games or open the game page.");
function publicGameUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { throw publicError("Enter an HTTPS itch.io game page URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.itch\.io$/i.test(url.hostname) ||
    !/^\/[a-z0-9][a-z0-9_.-]*\/?$/i.test(url.pathname) || url.search || url.hash)
    throw publicError("Enter an HTTPS itch.io game page URL, such as https://author.itch.io/game.");
  url.pathname = url.pathname.replace(/\/$/, ""); return url.href;
}
function downloadUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw publicError("itch.io returned an invalid download address."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname.includes(".") ||
    /^\d+(?:\.\d+){3}$/.test(url.hostname) || url.hostname.startsWith("[") || url.hostname.endsWith(".localhost") ||
    [...url.searchParams.keys()].some(key => /^(?:api_key|access_token|authorization)$/i.test(key)))
    throw publicError("itch.io returned an invalid download address.");
  return url;
}
function decode(value = "") {
  return value.replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d+|#x[a-f0-9]+);/gi, entity => {
    const named = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}
const plainText = value => decode(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([a-z_:][a-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
    .map(match => [match[1].toLowerCase(), decode(match[2] ?? match[3] ?? match[4])]));
}
function parsePage(html, url) {
  const meta = new Map([...html.matchAll(/<meta\b[^>]*>/gi)].map(match => { const a = attributes(match[0]); return [a.name || a.property, a.content || a.value || ""]; }));
  const appId = /^games\/([1-9]\d*)$/.exec(meta.get("itch:path") || "")?.[1] || /"game"\s*:\s*\{[^}]*"id"\s*:\s*([1-9]\d*)/.exec(html)?.[1];
  if (!appId) throw publicError("This page is not an available itch.io game. Check the game page URL and access.");
  const name = plainText(html.match(/<h1\b[^>]*class=["'][^"']*\bgame_title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] || meta.get("og:title") || `itch.io game ${appId}`);
  const uploads = [], stack = [];
  for (const match of html.matchAll(/<\/?div\b[^>]*>/gi)) {
    if (/^<\/div/i.test(match[0])) {
      const opening = stack.pop(); if (!opening?.upload) continue;
      const block = html.slice(opening.start, match.index + match[0].length), anchor = [...block.matchAll(/<a\b[^>]*>/gi)].map(value => attributes(value[0])).find(a => /^[1-9]\d*$/.test(a["data-upload_id"]));
      if (!anchor || uploads.some(upload => upload.id === anchor["data-upload_id"])) continue;
      const file = [...block.matchAll(/<strong\b[^>]*>[\s\S]*?<\/strong>/gi)].find(value => /(?:^|\s)name(?:\s|$)/.test(attributes(value[0].split(">")[0] + ">").class || ""));
      const rawFilename = file ? attributes(file[0].split(">")[0] + ">").title || plainText(file[0]) : "";
      const fallback = `itch-${appId}-${anchor["data-upload_id"]}.zip`, cleaned = path.posix.basename(rawFilename.replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 180);
      const filename = !cleaned || [".", "..", ".maclauncher-external.json"].includes(cleaned) ? fallback : cleaned;
      const platforms = [/(?:icon-windows|Download for Windows)/i.test(block) ? "windows" : null,
        /(?:icon-apple|Download for (?:Mac|OS X))/i.test(block) ? "macos" : null, /(?:icon-tux|Download for Linux)/i.test(block) ? "linux" : null].filter(Boolean);
      if (!platforms.length) {
        if (/(?:^|[_. -])(?:windows|win(?:32|64)?)(?:[_. -]|$)|\.exe$/i.test(filename)) platforms.push("windows");
        if (/(?:^|[_. -])(?:mac|macos|osx)(?:[_. -]|$)|\.dmg$/i.test(filename)) platforms.push("macos");
        if (/(?:^|[_. -])linux(?:[_. -]|$)|\.appimage$/i.test(filename)) platforms.push("linux");
        if (/(?:^|[_. -])html5?(?:[_. -]|$)|\.html$/i.test(filename)) platforms.push("web");
      }
      uploads.push({ id: anchor["data-upload_id"], filename, name: plainText(file?.[0] || filename), platforms });
    } else { const a = attributes(match[0]); stack.push({ start: match.index, upload: (a.class || "").split(/\s+/).includes("upload") }); }
  }
  const csrf = meta.get("csrf_token") || [...html.matchAll(/<input\b[^>]*>/gi)].map(match => attributes(match[0])).find(a => a.name === "csrf_token")?.value || "";
  const iconUrl = meta.get("og:image"), minPrice = Number(/"min_price"\s*:\s*(\d+)/.exec(html)?.[1] || 0);
  return { appId, name, url, csrf, minPrice, uploads, web: /(?:html_embed|game_frame)/.test(html),
    iconUrl: /^https:\/\/(?:img\.)?itch\.(?:zone|io)\//i.test(iconUrl || "") ? iconUrl : null };
}
function createItchPublicGames({ fetch: request = globalThis.fetch } = {}) {
  const pages = new Map(), cookies = new Map();
  function saveCookies(response, origin) {
    const values = response.headers.getSetCookie?.() || [], jar = cookies.get(origin) || new Map();
    for (const value of values) { const pair = value.split(";", 1)[0], split = pair.indexOf("="); if (split > 0) jar.set(pair.slice(0, split), pair.slice(split + 1)); }
    cookies.set(origin, jar);
  }
  async function siteRequest(value, options = {}, signal) {
    let address = new URL(value);
    for (let redirects = 0; redirects < 5; redirects++) {
      if (address.protocol !== "https:" || !/^(?:[a-z0-9-]+\.)?itch\.io$/i.test(address.hostname) || address.username || address.password || address.port) throw publicError("itch.io returned an invalid game page address.");
      const cookie = [...(cookies.get(address.origin) || new Map())].map(([key, value]) => `${key}=${value}`).join("; ");
      const response = await request(address.href, { ...options, headers: { Accept: "text/html,application/json", ...(cookie ? { Cookie: cookie } : {}), ...options.headers },
        redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
      saveCookies(response, address.origin);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const target = response.headers.get("location"); await response.body?.cancel?.(); if (!target) throw publicError("itch.io did not provide a game page address.");
        address = new URL(target, address); if (response.status === 303 || [301, 302].includes(response.status) && options.method === "POST") options = {}; continue;
      }
      if (!response.ok) throw [401, 403].includes(response.status) ? accessError() : publicError(response.status === 429 ? "itch.io is limiting requests. Try again later." : "The itch.io game page is unavailable. Check the URL and game access.");
      if (Number(response.headers.get("content-length")) > 8 * 1024 * 1024) throw publicError("itch.io returned too much game metadata.");
      const text = await response.text(); if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw publicError("itch.io returned too much game metadata.");
      return { text, url: address.href };
    }
    throw publicError("itch.io returned too many game page redirects.");
  }
  async function post(url, values, referer, signal) {
    const result = await siteRequest(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", Referer: referer }, body: new URLSearchParams(values).toString() }, signal);
    let data; try { data = JSON.parse(result.text); } catch { throw publicError("itch.io returned an invalid download response."); }
    if (data.errors?.length || !data.url) throw accessError(); return data;
  }
  async function readPage(value, { refresh = false, signal } = {}) {
    const canonical = publicGameUrl(value); if (!refresh && pages.has(canonical)) return pages.get(canonical);
    const result = await siteRequest(canonical, {}, signal), url = publicGameUrl(result.url), page = parsePage(result.text, url);
    pages.set(canonical, page); pages.set(url, page); return page;
  }
  async function downloadPage(page, signal) {
    if (page.download) return page.download;
    if (!page.csrf) throw accessError();
    if (page.minPrice > 0 && !page.uploads.length) throw accessError();
    const data = await post(`${page.url}/download_url`, { csrf_token: page.csrf, ...(page.uploads[0] ? { upload_id: page.uploads[0].id } : {}) }, page.url, signal);
    const address = new URL(data.url, page.url);
    if (address.origin !== new URL(page.url).origin || !address.pathname.startsWith(`${new URL(page.url).pathname}/download/`)) throw publicError("itch.io returned an invalid download page address.");
    const result = await siteRequest(address.href, {}, signal), download = parsePage(result.text, page.url);
    if (download.appId !== page.appId) throw publicError("itch.io returned a different game's download page.");
    download.referer = result.url; page.download = download; return download;
  }
  async function availablePage(value, options) {
    const page = await readPage(value, options);
    if (!page.uploads.length && page.minPrice === 0 && page.csrf) {
      try { const download = await downloadPage(page, options?.signal); page.uploads = download.uploads; }
      catch (error) { if (options?.signal?.aborted) throw error; if (!error.itchPublic) throw error; page.accessError = error.message; }
    }
    return page;
  }
  function row(page) {
    const advertised = [...new Set(page.uploads.flatMap(upload => upload.platforms))];
    return { appId: page.appId, name: page.name, url: page.url, iconUrl: page.iconUrl, store: "itch", shared: false, public: true,
      platforms: advertised.length ? advertised : page.web ? ["web"] : [], accessRequired: !page.uploads.length && (page.minPrice > 0 || Boolean(page.accessError)) };
  }
  async function resolveFile(page, upload, signal) {
    const download = await downloadPage(page, signal);
    if (!download.uploads.some(item => item.id === upload.id)) throw publicError("The selected itch.io upload is no longer available. Refresh versions and choose again.");
    const data = await post(`${page.url}/file/${upload.id}`, { csrf_token: download.csrf || page.csrf }, download.referer, signal);
    if (data.external) throw publicError("This itch.io upload is hosted externally. Open the game page to download it.");
    return downloadUrl(data.url).href;
  }
  async function inspectFile(address, signal) {
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await request(downloadUrl(address).href, { headers: { Range: "bytes=0-0", Accept: "application/octet-stream", "Accept-Encoding": "identity" }, redirect: "manual",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const target = response.headers.get("location"); await response.body?.cancel?.(); if (!target) throw publicError("itch.io did not provide a download address."); address = downloadUrl(target, address).href; continue;
      }
      const etag = response.headers.get("etag"), range = response.headers.get("content-range"), length = response.headers.get("content-length");
      await response.body?.cancel?.();
      if (!response.ok) throw publicError("The itch.io upload could not be read. Refresh versions and check game access.");
      const size = response.status === 206 ? Number(/\/(\d+)$/.exec(range || "")?.[1]) || null : Number(length) || null;
      return { etag: /^"[^"\r\n]+"$/.test(etag || "") ? etag : null, size };
    }
    throw publicError("itch.io returned too many download redirects.");
  }
  async function describeUpload(page, upload, signal) {
    const address = await resolveFile(page, upload, signal), inspection = await inspectFile(address, signal);
    const revision = inspection.etag ? crypto.createHash("sha256").update(JSON.stringify({ etag: inspection.etag, size: inspection.size, filename: upload.filename })).digest("hex").slice(0, 20) : null;
    return { address, choice: { id: `${upload.id}:public${revision ? `:${revision}` : ""}`, name: upload.name, uploadId: upload.id, buildId: null,
      version: `Upload ${upload.id}${revision ? ` · ${revision.slice(0, 12)}` : ""}`,
      platforms: upload.platforms, filename: upload.filename, size: inspection.size, checksum: null, exactIdentity: Boolean(revision), revision,
      etag: inspection.etag, access: "public" } };
  }
  async function getVersions(game, options = {}) {
    const page = await availablePage(game.url, options);
    if (page.appId !== String(game.appId)) throw publicError("The itch.io game page changed. Add its current URL again.");
    if (!page.uploads.length) throw page.web && !page.minPrice ? publicError("This game is available in the browser and has no public downloadable files. Open the game page to play it.") : accessError();
    const branches = []; for (const upload of page.uploads) branches.push((await describeUpload(page, upload, options.signal)).choice);
    return { appId: page.appId, name: page.name, platforms: [...new Set(branches.flatMap(branch => branch.platforms))].length ? [...new Set(branches.flatMap(branch => branch.platforms))] : game.platforms,
      branches, languages: [], uploads: page.uploads.map(upload => ({ id: upload.id, name: upload.name, platforms: upload.platforms, versions: branches.filter(branch => branch.uploadId === upload.id).map(branch => branch.id) })),
      historyNote: "Public downloadable files are listed individually. Earlier builds require publisher access or a separately published upload." };
  }
  async function resolveDownload(game, choice, { signal } = {}) {
    const page = await availablePage(game.url, { refresh: true, signal }), upload = page.uploads.find(item => item.id === choice.uploadId);
    if (!upload || page.appId !== String(game.appId)) throw publicError("The selected itch.io upload is no longer available. Refresh versions and choose again.");
    const { choice: current, address } = await describeUpload(page, upload, signal);
    if (current.id !== choice.id || current.filename !== choice.filename || choice.size && current.size !== choice.size)
      throw publicError("The selected itch.io file changed. Refresh versions and choose its current upload.");
    return { url: address, headers: { "Accept-Encoding": "identity", ...(choice.etag ? { "If-Match": choice.etag } : {}) } };
  }
  return { discoverGame: async (url, options = {}) => row(await availablePage(url, options)), getVersions, resolveDownload,
    dispose: () => { pages.clear(); cookies.clear(); } };
}

module.exports = { createItchPublicGames, publicGameUrl, parsePublicItchPage: parsePage };
