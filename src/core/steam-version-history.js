const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./json-files');

const ORIGIN = 'https://steamdb.info';
function steamId(value) {
  const text = String(value ?? '');
  if (!/^[1-9]\d{0,9}$/.test(text) || Number(text) > 0xffffffff) throw new Error('Choose a valid Steam app or depot.');
  return text;
}
function historyUrl(appId, depotId) {
  appId = steamId(appId);
  return depotId == null ? `${ORIGIN}/app/${appId}/depots/` : `${ORIGIN}/depot/${steamId(depotId)}/manifests/`;
}
function validManifest(value) { return /^[1-9]\d{0,19}$/.test(value || '') && BigInt(value) <= 0xffffffffffffffffn; }
function textContent(html) { return html.replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|#160);/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); }
function parseManifestHistory(html, depotId, observedAt = new Date().toISOString()) {
  depotId = steamId(depotId);
  // Only the manifest table is relevant; file hashes and unrelated page IDs
  // must never become downloadable versions.
  const heading = /Previously seen manifests/i.exec(html);
  const section = heading ? html.slice(heading.index).split(/<h[12]\b/i)[0] :
    html.match(/<table\b[^>]*id=["'](?:manifests|table-manifests)["'][^>]*>[\s\S]*?<\/table>/i)?.[0] || '';
  const entries = new Map();
  for (const match of section.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    const row = match[0];
    let manifestId = row.match(/\bdata-manifest(?:id|-id)?=["'](\d+)["']/i)?.[1] ||
      row.match(/[?&](?:amp;)?manifest=(\d+)/i)?.[1] || row.match(/download_depot\s+\d+\s+\d+\s+(\d+)/i)?.[1];
    if (!manifestId) for (const cell of row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)) {
      const value = textContent(cell[1]); if (/^\d{15,20}$/.test(value)) { manifestId = value; break; }
    }
    if (!validManifest(manifestId)) continue;
    const timestamp = row.match(/\bdata-(?:timestamp|time|sort)=["'](\d{9,13})["']/i)?.[1];
    const iso = row.match(/\bdatetime=["']([^"']+)["']/i)?.[1];
    const date = iso ? Date.parse(iso) : timestamp ? Number(timestamp) * (timestamp.length > 10 ? 1 : 1000) : NaN;
    const branch = row.match(/\bdata-branch=["']([a-z0-9_. -]{1,100})["']/i)?.[1];
    entries.set(manifestId, { depotId, manifestId, observedAt,
      ...(Number.isFinite(date) ? { date: new Date(date).toISOString() } : {}), ...(branch ? { branch } : {}) });
    if (entries.size >= 1000) break;
  }
  return [...entries.values()];
}
async function boundedHtml(response) {
  if (Number(response.headers.get('content-length')) > 3 * 1024 * 1024) throw new Error('SteamDB returned too much version data.');
  const chunks = []; let bytes = 0;
  if (!response.body) return '';
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 3 * 1024 * 1024) throw new Error('SteamDB returned too much version data.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
function createSteamVersionHistory({ userDataDir, fetch: request = globalThis.fetch } = {}) {
  const inFlight = new Map(), controller = new AbortController();
  function read(appId, depotId) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(userDataDir, 'steam/history', appId, `${depotId}.json`), 'utf8'));
      return value?.depotId === depotId && Array.isArray(value.history) ? value : null;
    } catch { return null; }
  }
  async function get(appValue, depotValues, { refresh = false } = {}) {
    const appId = steamId(appValue);
    if (!Array.isArray(depotValues) || !depotValues.length || depotValues.length > 32) throw new Error('Choose up to 32 depots to fetch previous versions.');
    const depotIds = [...new Set(depotValues.map(steamId))].sort();
    const key = `${appId}:${depotIds.join(',')}:${refresh}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const task = (async () => {
      const sources = depotIds.map(depotId => ({ depotId, url: historyUrl(appId, depotId) }));
      const result = { history: [], sourceUrl: historyUrl(appId), sources, fetchedAt: new Date().toISOString(), blocked: false };
      let unavailable = false;
      for (const { depotId, url } of sources) {
        const cached = read(appId, depotId);
        if (cached) result.history.push(...cached.history);
        if (cached && !refresh || unavailable) continue;
        try {
          const response = await request(url, { headers: { Accept: 'text/html', 'User-Agent': 'MacLauncher/0.3 (+https://github.com/procrastinine/maclauncher)' },
            redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) });
          if ([401, 403, 429].includes(response.status)) {
            await response.body?.cancel(); unavailable = result.blocked = true;
            result.message = 'SteamDB requires browser access. Open its manifest page to find an earlier version.'; continue;
          }
          if (!response.ok) { await response.body?.cancel(); throw new Error('SteamDB could not load previous versions.'); }
          const html = await boundedHtml(response);
          if (/cf-chl-|challenge-platform|Just a moment\.\.\./i.test(html)) {
            unavailable = result.blocked = true; result.message = 'SteamDB requires browser access. Open its manifest page to find an earlier version.'; continue;
          }
          const history = parseManifestHistory(html, depotId, result.fetchedAt);
          if (!history.length) { result.message = 'No earlier manifests were returned. Open SteamDB to view available history.'; continue; }
          const merged = new Map((cached?.history || []).map(item => [item.manifestId, item]));
          for (const item of history) merged.set(item.manifestId, item);
          writeJsonAtomic(path.join(userDataDir, 'steam/history', appId, `${depotId}.json`), { depotId, history: [...merged.values()].slice(-1000), fetchedAt: result.fetchedAt });
          result.history = result.history.filter(item => item.depotId !== depotId).concat(history, (cached?.history || []).filter(item => !history.some(row => row.manifestId === item.manifestId)));
        } catch (error) {
          if (controller.signal.aborted) throw error;
          unavailable = true; result.message = 'SteamDB could not load previous versions. Open its manifest page or try again later.';
        }
      }
      return result;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, task); return task;
  }
  return { get, dispose: () => controller.abort() };
}
module.exports = { createSteamVersionHistory, parseManifestHistory, historyUrl };
