const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { steamLibraryArchitectures, steamPlatforms } = require('./steam-architectures');

// Steam cache v39-v41, including v41's interned keys. Format reference:
// https://github.com/ValveResourceFormat/SteamAppInfo
function parseAppInfoCache(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > 128 * 1024 * 1024) throw new Error('Invalid Steam app cache.');
  const magic = buffer.readUInt32LE(0), version = magic & 255;
  if (![0x07564427, 0x07564428, 0x07564429].includes(magic)) throw new Error('Unsupported Steam app cache version.');
  let offset = version >= 41 ? 16 : 8, limit = buffer.length;
  let keys = null;
  function need(bytes) { if (offset + bytes > limit) throw new Error('Incomplete Steam app cache.'); }
  function u32() { need(4); const value = buffer.readUInt32LE(offset); offset += 4; return value; }
  function string() {
    const end = buffer.indexOf(0, offset);
    if (end < offset || end >= limit) throw new Error('Incomplete Steam app cache string.');
    const value = buffer.toString('utf8', offset, end); offset = end + 1; return value;
  }
  if (version >= 41) {
    const tableOffset = Number(buffer.readBigUInt64LE(8));
    if (!Number.isSafeInteger(tableOffset) || tableOffset < 16 || tableOffset + 4 > buffer.length) throw new Error('Invalid Steam key table.');
    offset = tableOffset; const count = u32();
    if (count > 1000000) throw new Error('Steam key table is too large.');
    keys = Array.from({ length: count }, () => string());
    limit = tableOffset; offset = 16;
  }
  let entries = 0;
  function object(depth) {
    if (depth > 64) throw new Error('Steam app cache is nested too deeply.');
    const result = Object.create(null);
    while (offset < limit) {
      need(1); const type = buffer[offset++];
      if (type === 8 || type === 11) return result;
      if (++entries > 2000000) throw new Error('Steam app cache has too many entries.');
      const name = keys ? keys[u32()] : string();
      if (typeof name !== 'string') throw new Error('Invalid Steam cache key.');
      let value;
      if (type === 0) value = object(depth + 1);
      else if (type === 1) value = string();
      else if ([2, 4, 6].includes(type)) { need(4); value = buffer.readInt32LE(offset); offset += 4; }
      else if (type === 3) { need(4); value = buffer.readFloatLE(offset); offset += 4; }
      else if (type === 7 || type === 10) { need(8); value = (type === 7 ? buffer.readBigUInt64LE(offset) : buffer.readBigInt64LE(offset)).toString(); offset += 8; }
      else if (type === 5) { const start = offset; while (true) { need(2); const unit = buffer.readUInt16LE(offset); offset += 2; if (!unit) break; } value = buffer.toString('utf16le', start, offset - 2); }
      else throw new Error('Unsupported Steam cache value.');
      result[name] = value;
    }
    throw new Error('Incomplete Steam app cache object.');
  }
  const apps = new Map();
  while (offset + 4 <= limit) {
    const appId = u32(); if (!appId) break;
    const size = u32(), start = offset, end = start + size;
    const fixed = version >= 40 ? 60 : 40;
    if (size < fixed || end > limit) throw new Error('Invalid Steam app cache record.');
    offset += fixed;
    const outerLimit = limit; limit = end;
    const value = object(0); apps.set(appId, value.appinfo || value);
    offset = end; limit = outerLimit;
  }
  return apps;
}

function parseSteamLicenses(text) {
  const clean = String(text).replace(/\\r\\n/g, '\n').replace(/^\[[^\]\n]+\]\s*/gm, '');
  const blocks = clean.split(/License packageID\s+\d+\s*:/i).slice(1), apps = new Map();
  for (const block of blocks) {
    const section = /-\s*Apps\s*:\s*([\s\S]*?)(?:\(\d+\s+in total\)|-\s*Depots\s*:)/i.exec(block);
    if (!section || !/\bActive\b/i.test(block.split(/-\s*Apps\s*:/i)[0]) || /\bExpired\b|\bRevoked\b/i.test(block.split(/-\s*Apps\s*:/i)[0])) continue;
    const shared = /\bBorrowed\b|Family Group/i.test(block.split(/-\s*Apps\s*:/i)[0]);
    for (const match of section[1].matchAll(/\b[1-9]\d{0,9}\b/g)) {
      const appId = Number(match[0]); if (appId > 0xffffffff) continue;
      const old = apps.get(appId); apps.set(appId, { appId, shared: old ? old.shared && shared : shared });
    }
  }
  return [...apps.values()];
}

async function readAppInfo(homeDir = os.homedir()) {
  const file = path.join(homeDir, 'Library/Application Support/Steam/appcache/appinfo.vdf');
  const stat = await fs.stat(file); if (stat.size > 128 * 1024 * 1024) throw new Error('Steam app cache is too large.');
  return parseAppInfoCache(await fs.readFile(file));
}
async function cachedIcon(steamRoot, appId, hash) {
  const roots = [path.join(steamRoot, 'appcache/librarycache', String(appId)), path.join(steamRoot, 'appcache/librarycache')];
  for (const root of roots) {
    let names; try { names = await fs.readdir(root); } catch { continue; }
    const candidates = names.filter(name => /\.(png|jpe?g|webp)$/i.test(name) && (root.endsWith(String(appId)) || name.startsWith(`${appId}_`)))
      .sort((a, b) => Number(!/icon/i.test(a)) - Number(!/icon/i.test(b)));
    for (const name of candidates.slice(0, 8)) { const file = path.join(root, name); try { if ((await fs.stat(file)).isFile()) return pathToFileURL(file).href; } catch {} }
  }
  return null;
}
function createSteamClientLibrary({ homeDir = os.homedir(), queryConsole, onProgress } = {}) {
  let cached, cachedApps;
  return {
    async loadLibrary({ refresh = false, licenses: suppliedLicenses } = {}) {
      if (!refresh && cached) return cached;
      const licenses = parseSteamLicenses(suppliedLicenses || await queryConsole('licenses_print', [], { timeoutMs: 30000 }));
      if (!licenses.length) throw new Error('Steam did not return an active game library. Sign in to Steam for Mac and reload.');
      let appinfo; try { appinfo = await readAppInfo(homeDir); } catch { appinfo = new Map(); }
      cachedApps = appinfo;
      const rows = [], steamRoot = path.join(homeDir, 'Library/Application Support/Steam');
      for (const license of licenses) {
        const info = appinfo.get(license.appId), common = info?.common || {}, type = String(common.type || 'game').toLowerCase();
        if (!['game', 'application', 'demo', 'mod', 'music', 'beta'].includes(type)) continue;
        rows.push({ ...license, name: common.name || `App ${license.appId}`, ...steamLibraryArchitectures(info),
          platforms: steamPlatforms(common.oslist),
          iconUrl: await cachedIcon(steamRoot, license.appId, common.icon) });
      }
      cached = rows.sort((a, b) => a.name.localeCompare(b.name)); onProgress?.(); return cached;
    },
    async getAppInfo(appId) { try { cachedApps ||= await readAppInfo(homeDir); return cachedApps.get(Number(appId)) || null; } catch { return null; } }
  };
}
module.exports = { parseAppInfoCache, parseSteamLicenses, readAppInfo, createSteamClientLibrary };
