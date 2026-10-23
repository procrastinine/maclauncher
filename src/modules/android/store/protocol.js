const https = require("node:https");
const crypto = require("node:crypto");
const { decodeResponseBody } = require("../../shared/runtime/download-utils");

// Wire field identities are interoperable protocol declarations. References:
// Aurora GPlayAPI 3.6.4, 18ec2bd74995d30e500b756359a4de3e37976f03,
// GooglePlay.proto; gplaydl 4.2.1 delivery metadata. No upstream implementation
// or Android runtime is loaded by this independent desktop client.
const BASE = "https://android.clients.google.com";
const ARCHITECTURES = ["arm64", "armv7", "x86_64", "x86"];
const ANDROID_SDKS = Array.from({ length: 16 }, (_, index) => index + 21);
const PACKAGE = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+$/;
const publicError = (message, details = {}) => Object.assign(new Error(message), { playPublic: true, ...details });
function packageName(input) {
  let value = String(input || "").trim();
  if (/^https:\/\//i.test(value)) { const url = new URL(value); if (url.hostname !== "play.google.com" || url.pathname !== "/store/apps/details") throw publicError("Enter an app package name or Google Play app URL."); value = url.searchParams.get("id") || ""; }
  if (!PACKAGE.test(value) || value.length > 240) throw publicError("Enter a valid Android package name.");
  return value;
}
function versionCode(value) { const text = String(value || ""); if (!/^[1-9]\d{0,18}$/.test(text) || BigInt(text) > 0x7fffffffffffffffn) throw publicError("Enter a positive Android version code."); return text; }
function varint(value) { let n = BigInt(value), bytes = []; if (n < 0n) throw Error("Invalid protocol number."); do { const b = Number(n & 127n); n >>= 7n; bytes.push(b | (n ? 128 : 0)); } while (n); return Buffer.from(bytes); }
function field(id, value, type = typeof value === "number" || typeof value === "bigint" ? 0 : 2) {
  const key = varint(id * 8 + type);
  if (type === 0) return Buffer.concat([key, varint(value)]);
  if (type === 1) { const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt(value)); return Buffer.concat([key, data]); }
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value)); return Buffer.concat([key, varint(data.length), data]);
}
const message = (...fields) => Buffer.concat(fields.flat());
function fields(data) {
  if (!Buffer.isBuffer(data) || data.length > 32 * 1024 * 1024) throw publicError("Google Play returned invalid metadata.");
  const result = new Map(); let cursor = 0, count = 0;
  const number = () => { let value = 0n, shift = 0n; while (cursor < data.length && shift < 70n) { const byte = data[cursor++]; value |= BigInt(byte & 127) << shift; if (!(byte & 128)) return value; shift += 7n; } throw publicError("Google Play returned incomplete metadata."); };
  function object(depth, closing) {
    if (depth > 24) throw publicError("Google Play metadata is nested too deeply.");
    const map = new Map();
    while (cursor < data.length) {
      if (++count > 250000) throw publicError("Google Play returned too much metadata.");
      const tag = Number(number()), id = tag >>> 3, wire = tag & 7; if (!id) throw publicError("Google Play returned invalid metadata.");
      if (wire === 4) { if (closing !== id) throw publicError("Google Play returned invalid metadata."); return map; }
      let value;
      if (wire === 0) value = number().toString();
      else if (wire === 1 || wire === 5) { const length = wire === 1 ? 8 : 4; if (cursor > data.length - length) throw publicError("Google Play returned incomplete metadata."); value = wire === 1 ? data.readBigUInt64LE(cursor).toString() : String(data.readUInt32LE(cursor)); cursor += length; }
      else if (wire === 2) { const length = Number(number()); if (!Number.isSafeInteger(length) || cursor > data.length - length) throw publicError("Google Play returned incomplete metadata."); value = data.subarray(cursor, cursor + length); cursor += length; }
      else if (wire === 3) value = object(depth + 1, id);
      else throw publicError("Google Play returned invalid metadata.");
      if (!map.has(id)) map.set(id, []); map.get(id).push(value);
    }
    if (closing) throw publicError("Google Play returned incomplete metadata.");
    return map;
  }
  return object(0);
}
const first = (map, id) => map?.get(id)?.[0];
const text = (map, id) => Buffer.isBuffer(first(map, id)) ? first(map, id).toString("utf8") : String(first(map, id) || "");
const nested = (map, id) => Buffer.isBuffer(first(map, id)) ? fields(first(map, id)) : new Map();
const all = (map, id) => (map?.get(id) || []).filter(Buffer.isBuffer).map(fields);
function payload(body) {
  const response = fields(body), commands = nested(response, 2);
  if (text(commands, 1)) throw publicError("Google Play could not complete this request. Check account access and device compatibility.");
  return nested(response, 1);
}
function profile(architecture = "arm64", locale = "en-US", androidSdk = 34) {
  if (!ARCHITECTURES.includes(architecture)) throw publicError("Choose a supported Android architecture.");
  if (!/^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/.test(locale)) throw publicError("Choose a valid language code.");
  androidSdk = Number(androidSdk); if (!ANDROID_SDKS.includes(androidSdk)) throw publicError("Choose an Android SDK level from 21 to 36.");
  const modern = androidSdk >= 28;
  const abis = { arm64: ["arm64-v8a", "armeabi-v7a", "armeabi"], armv7: ["armeabi-v7a", "armeabi"], x86_64: ["x86_64", "x86"], x86: ["x86"] }[architecture];
  const release = ({ 21: "5.0", 22: "5.1", 23: "6.0", 24: "7.0", 25: "7.1.2", 26: "8.0", 27: "8.1", 28: "9", 29: "10", 30: "11", 31: "12", 32: "12", 33: "13", 34: "14", 35: "15", 36: "16" })[androidSdk];
  return { architecture, locale: locale.replace("_", "-"), sdk: androidSdk, androidSdk, release, device: architecture.startsWith("arm") ? modern ? "lynx" : "hammerhead" : modern ? "emu64xa" : "generic_x86",
    model: architecture.startsWith("arm") ? modern ? "Pixel 7a" : "Nexus 5" : "Android SDK built for x86", manufacturer: "Google", buildId: modern ? "UQ1A.240205.002" : "N2G48C", abis,
    features: ["android.hardware.touchscreen", "android.hardware.touchscreen.multitouch", "android.hardware.faketouch", "android.hardware.screen.landscape", "android.hardware.screen.portrait", "android.hardware.wifi", "android.hardware.bluetooth", "android.hardware.camera", "android.hardware.camera.autofocus", "android.hardware.location", "android.hardware.location.gps", "android.hardware.sensor.accelerometer", "android.software.webview", "android.software.app_widgets", "android.software.activities_on_secondary_displays"] };
}
function deviceConfiguration(device) {
  return message(field(1, 3), field(2, 1), field(3, 1), field(4, 2), field(5, 0), field(6, 0), field(7, 420), field(8, 196610),
    ["org.apache.http.legacy", "android.test.base"].map(value => field(9, value)), device.features.map(value => field(10, value)), device.abis.map(value => field(11, value)),
    field(12, 1080), field(13, 2400), [device.locale.replace("-", "_"), "en_US"].map(value => field(14, value)), field(16, 0), field(18, 411), field(19, 0), field(20, 8589934592n), field(21, 8),
    device.features.map(value => field(26, message(field(1, value), field(2, 0)))));
}
function checkinRequest(device) {
  const build = message(field(1, `google/${device.device}/${device.device}:${device.release}/${device.buildId}/11269751:user/release-keys`), field(2, device.device), field(3, "google"), field(4, "unknown"), field(5, "unknown"), field(6, "android-google"), field(7, Math.floor(Date.now() / 1000)), field(8, 244431000), field(9, device.device), field(10, device.sdk), field(11, device.model), field(12, device.manufacturer), field(13, device.device), field(14, 0));
  return message(field(2, 0), field(4, message(field(1, build), field(2, 0), field(6, "310260"), field(7, "310260"), field(8, "mobile-notroaming"), field(9, 0))), field(6, device.locale.replace("-", "_")), field(12, "UTC"), field(14, 3), field(18, deviceConfiguration(device)), field(20, 0));
}
function headers(auth) {
  const device = auth.device;
  return { Authorization: `Bearer ${auth.authToken || ""}`, "User-Agent": `Android-Finsky/41.2.29-23 [0] [PR] 639844241 (api=3,versionCode=84122900,sdk=${device.sdk},device=${device.device},hardware=${device.device},product=${device.device},platformVersionRelease=${device.release},model=${encodeURIComponent(device.model)},buildId=${device.buildId},isWideScreen=0,supportedAbis=${device.abis.join(";")})`,
    "X-DFE-Device-Id": auth.androidId, "Accept-Language": device.locale, "X-DFE-Client-Id": "am-android-google", "X-DFE-Network-Type": "4", "X-DFE-No-Prefetch": "true", "X-DFE-UserLanguages": device.locale,
    "X-DFE-Device-Checkin-Consistency-Token": auth.consistencyToken || "", "X-DFE-Device-Config-Token": auth.deviceConfigToken || "", "X-DFE-Cookie": auth.dfeCookie || "", "Content-Type": "application/x-protobuf", Accept: "application/x-protobuf" };
}
async function request(url, { method = "GET", headers: extra = {}, body, signal, maxBytes = 32 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted(); const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "android.clients.google.com") throw publicError("Google Play returned an unsupported service address.");
  return new Promise((resolve, reject) => {
    const req = https.request(endpoint, { method, headers: { "Accept-Encoding": "gzip", ...extra, ...(body ? { "Content-Length": String(body.length) } : {}) }, signal, timeout: 30000 }, response => {
      const chunks = []; let received = 0;
      response.on("data", bytes => { received += bytes.length; if (received > maxBytes) response.destroy(publicError("Google Play returned too much data.")); else chunks.push(bytes); });
      response.on("error", reject); response.on("end", () => { try { resolve({ status: response.statusCode, headers: response.headers, body: decodeResponseBody(Buffer.concat(chunks), response.headers, { maxBytes }) }); } catch (error) { reject(error); } });
    });
    req.on("timeout", () => req.destroy(publicError("Google Play timed out. Try the action again."))); req.on("error", reject); req.end(body);
  });
}
function parseApp(item, owned = false) {
  const appId = text(item, 1); if (!PACKAGE.test(appId)) return null;
  const detail = nested(nested(item, 13), 1), typedApp = text(item, 3) === "1" && text(item, 4) === "3";
  // Search containers can have package-shaped IDs. Only app documents carry
  // AppDetails or an application document type/backend without a container.
  if (!first(detail, 3) && text(detail, 14) !== appId && !(typedApp && !first(item, 12) && !first(item, 11))) return null;
  const offers = all(item, 8), offer = offers.find(row => text(row, 8) === "1") || offers[0], image = all(item, 10).find(row => text(row, 1) === "4") || all(item, 10)[0];
  const splits = [...new Set([...(detail.get(25) || []).filter(Buffer.isBuffer).map(value => value.toString("utf8")), ...all(detail, 17).map(row => text(row, 4) || text(row, 9)).filter(Boolean)])];
  const supportedArchitectures = ARCHITECTURES.filter(architecture => splits.some(name => ({ arm64: /(?:^|[._-])arm64[._-]v8a(?:$|[._-])/i, armv7: /(?:^|[._-])armeabi[._-]v7a(?:$|[._-])/i, x86_64: /(?:^|[._-])x86_64(?:$|[.-])/i, x86: /(?:^|[._-])x86(?:$|[.-])/i })[architecture].test(name)));
  return { appId, name: text(item, 5) || appId, developer: text(item, 6), platforms: ["android"], owned, versionCode: text(detail, 3) || null, versionName: text(detail, 4) || null, downloadSize: Number(text(detail, 9)) || null,
    iconUrl: text(image, 5) || null, offerType: Number(text(offer, 8)) || 1, priceMicros: offer && first(offer, 1) !== undefined ? text(offer, 1) : null, checkoutRequired: text(offer, 5) === "1", price: text(offer, 3), updatedAt: text(detail, 16) || null,
    canAddToLibrary: !owned && offer && text(offer, 1) === "0" && text(offer, 5) !== "1" || false,
    splits, supportedArchitectures };
}
function parseApps(body, { owned = false } = {}) {
  const found = new Map(), response = fields(body); let visited = 0;
  function walk(map, depth) {
    if (depth > 14 || ++visited > 12000) return;
    const row = parseApp(map, owned); if (row && !found.has(row.appId)) found.set(row.appId, row);
    for (const values of map.values()) for (const value of values) if (Buffer.isBuffer(value) && value.length > 8) { try { walk(fields(value), depth + 1); } catch { /* Text and images are not nested protocol messages. */ } }
  }
  walk(response, 0); return [...found.values()];
}
function hash(value, bytes) { if (!value) return null; if (new RegExp(`^[a-f0-9]{${bytes * 2}}$`, "i").test(value)) return value.toLowerCase(); const buffer = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64"); return buffer.length === bytes ? buffer.toString("hex") : null; }
function parseDelivery(body, appId, requestedCode) {
  const delivery = nested(payload(body), 21), status = Number(text(delivery, 1) || 1), data = nested(delivery, 2);
  if (status === 3) throw publicError("Google Play has not licensed this app for the selected account.", { notOwned: true });
  if ([2, 7, 9].includes(status)) throw publicError("Google Play does not serve this app version to the selected device profile.", { unavailable: true });
  if (status !== 1 || !text(data, 3)) throw publicError("Google Play did not return this app version.");
  const make = (source, filename, type, urlField, sizeField, sha1Field, sha256Field) => ({ filename, type, url: text(source, urlField), size: Number(text(source, sizeField)) || null, sha1: hash(text(source, sha1Field), 20), sha256: hash(text(source, sha256Field), 32) });
  const base = make(data, "base.apk", "base", 3, 1, 2, 19), files = [base];
  base.cookies = all(data, 5).map(cookie => ({ name: text(cookie, 1), value: text(cookie, 2) }));
  for (const split of all(data, 15)) {
    const name = text(split, 1); if (!/^[a-zA-Z0-9_.-]{1,240}$/.test(name)) throw publicError("Google Play supplied an invalid split name.");
    files.push(make(split, `split_${name}.apk`, "split", 5, 2, 4, 9));
  }
  for (const extra of all(data, 4)) {
    const type = Number(text(extra, 1)), code = text(extra, 2) || requestedCode;
    if (![0, 1, 2].includes(type) || !text(extra, 4)) continue;
    versionCode(code);
    files.push(make(extra, type === 2 ? `asset_${files.length}.apk` : `Android/obb/${appId}/${type === 0 ? "main" : "patch"}.${code}.${appId}.obb`, type === 2 ? "asset" : "obb", 4, 3, 8, 0));
  }
  if (files.length > 1024 || new Set(files.map(file => file.filename)).size !== files.length) throw publicError("Google Play supplied conflicting package files.");
  for (const file of files) { const url = new URL(file.url); if (url.protocol !== "https:" || !/(?:^|\.)(?:google\.com|googleapis\.com|googleusercontent\.com|gvt1\.com|ggpht\.com)$/.test(url.hostname)) throw publicError("Google Play supplied an unsupported download address."); if (["base", "split"].includes(file.type) && !file.sha1 && !file.sha256) throw publicError("Google Play did not provide an APK integrity hash."); }
  return { appId, versionCode: requestedCode, files };
}
function createPlayProtocol(options = {}) {
  const send = options.request || request;
  async function checked(url, args = {}) { const response = await send(url, args); if (response.status === 401 || response.status === 403) throw publicError("Google Play sign-in expired or access was denied. Sign in again.", { authExpired: true }); if (response.status < 200 || response.status >= 300) throw publicError(`Google Play could not complete the request (HTTP ${response.status}).`, { httpStatus: response.status }); return response; }
  async function prepareDevice({ architecture = "arm64", locale = "en-US", androidSdk = 34, signal } = {}) {
    const device = profile(architecture, locale, androidSdk), response = await checked(`${BASE}/checkin`, { method: "POST", body: checkinRequest(device), headers: { "Content-Type": "application/x-protobuffer", "User-Agent": `GoogleAuth/1.4 (${device.device} ${device.buildId})`, app: "com.google.android.gms" }, signal });
    const result = fields(response.body), id = text(result, 7); if (!id || id === "0") throw publicError("Google Play could not register the selected device profile.");
    return { device, androidId: BigInt(id).toString(16), securityToken: text(result, 8), consistencyToken: text(result, 12), createdAt: new Date().toISOString() };
  }
  async function authorize(session, registration, { signal } = {}) {
    const device = registration.device, values = new URLSearchParams({ Email: session.email, Token: session.aasToken, androidId: registration.androidId, service: "oauth2:https://www.googleapis.com/auth/googleplay", app: "com.android.vending", callerPkg: "com.google.android.gms", client_sig: "38918a453d07199354f8b19af05ec6562ced5788", callerSig: "38918a453d07199354f8b19af05ec6562ced5788", sdk_version: String(device.sdk), google_play_services_version: "244431000", device_country: "us", lang: device.locale.split("-")[0], oauth2_foreground: "1", token_request_options: "CAA4AVAB", check_email: "1", system_partition: "1", droidguard_results: "null" });
    let tokens;
    if (session.authToken) tokens = { Auth: session.authToken, Expiry: String(Math.floor(Date.now() / 1000) + (Number(session.expirySeconds) || 3000)) };
    else {
      const response = await checked(`${BASE}/auth`, { method: "POST", body: Buffer.from(values.toString()), headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": `GoogleAuth/1.4 (${device.device} ${device.buildId})`, app: "com.google.android.gms" }, signal });
      tokens = Object.fromEntries(response.body.toString("utf8").split(/\r?\n/).filter(line => line.includes("=")).map(line => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; }));
    }
    if (!tokens.Auth) throw publicError("Google Play did not accept this account session. Sign in again.", { authExpired: true });
    const auth = { ...registration, authToken: tokens.Auth, expiresAt: Math.min(Number(tokens.Expiry) * 1000 || Infinity, Date.now() + 50 * 60 * 1000) };
    const configResponse = await checked(`${BASE}/fdfe/uploadDeviceConfig`, { method: "POST", body: message(field(1, deviceConfiguration(device))), headers: headers(auth), signal });
    auth.deviceConfigToken = text(nested(payload(configResponse.body), 28), 1); return auth;
  }
  async function query(auth, action, params, { signal, method = "GET", body } = {}) {
    const endpoint = new URL(`${BASE}/fdfe/${action}`); for (const [key, value] of Object.entries(params || {})) endpoint.searchParams.set(key, String(value));
    return (await checked(endpoint.href, { headers: headers(auth), signal, method, body })).body;
  }
  async function details(auth, input, { signal } = {}) { const appId = packageName(input), body = await query(auth, "details", { doc: appId }, { signal }); const row = parseApp(nested(nested(payload(body), 2), 4)); if (!row || !/^[1-9]\d*$/.test(row.versionCode || "")) throw publicError("Google Play does not offer a current app version for this architecture and Android SDK level.", { unavailable: true }); return row; }
  async function search(auth, input, { signal } = {}) { const queryText = String(input || "").trim(); if (queryText.length < 2 || queryText.length > 240) throw publicError("Enter an app name or package name to search."); if (PACKAGE.test(queryText) || /^https:\/\/play\.google\.com\//i.test(queryText)) return [await details(auth, queryText, { signal })]; const body = await query(auth, "search", { q: queryText, c: 3 }, { signal }); payload(body); return parseApps(body).slice(0, 100); }
  async function library(auth, { signal } = {}) {
    const result = new Map(); let offset = 0, truncated = false;
    for (let page = 0; page < 30; page++) {
      const body = await query(auth, "purchaseHistory", { o: offset }, { signal }); payload(body); const rows = parseApps(body, { owned: true });
      let added = 0; for (const row of rows) if (!result.has(row.appId)) { result.set(row.appId, row); added++; }
      if (!added) break; offset += rows.length; truncated = page === 29;
    }
    return { library: [...result.values()], truncated };
  }
  async function delivery(auth, detailsRow, requestedCode, { signal, includeExtras = true } = {}) {
    const appId = packageName(detailsRow.appId), code = versionCode(requestedCode); let body;
    try { body = await query(auth, "delivery", { doc: appId, ot: detailsRow.offerType || 1, vc: code }, { signal }); return parseDelivery(body, appId, code); }
    catch (error) { if (!error.notOwned) throw error; }
    return (await acquire(auth, detailsRow, code, { signal })).delivery;
  }
  async function acquire(auth, detailsRow, requestedCode = detailsRow.versionCode, { signal } = {}) {
    const appId = packageName(detailsRow.appId), code = versionCode(requestedCode);
    // Only explicitly free offers can enter acquisition. No payment instrument,
    // checkout token, signed cart or paid-purchase confirmation is submitted.
    if (detailsRow.priceMicros !== "0" || detailsRow.checkoutRequired) throw publicError("This app is not licensed for the selected account. Purchase it in Google Play before downloading.");
    const acquire = message(field(1, message(field(1, message(field(1, appId), field(2, 1), field(3, 3))), field(2, 1))), field(12, message(field(1, BigInt(code)), field(3, 0))), field(13, detailsRow.offerType || 1), field(15, 0), field(22, crypto.randomBytes(16).toString("base64url")), field(25, 2), field(30, message(field(1, 2), field(2, 0))));
    const acquired = await query(auth, "acquire", {}, { signal, method: "POST", body: acquire });
    const confirmation = nested(nested(nested(fields(acquired), 1), 94), 3), acquisitionConfirmed = first(confirmation, 12) !== undefined || first(confirmation, 15) !== undefined;
    const purchase = await query(auth, "purchase", { doc: appId, ot: detailsRow.offerType || 1, vc: code }, { signal, method: "POST", body: Buffer.alloc(0) }), token = text(nested(payload(purchase), 4), 55);
    const body = await query(auth, "delivery", { doc: appId, ot: detailsRow.offerType || 1, vc: code, ...(token ? { dtok: token } : {}) }, { signal });
    const verifiedDelivery = parseDelivery(body, appId, code);
    if (!acquisitionConfirmed && !token) throw publicError("Google Play did not confirm adding this free app to the account.");
    return { appId, versionCode: code, licensed: true, delivery: verifiedDelivery };
  }
  return { prepareDevice, authorize, details, search, library, delivery, acquire };
}
module.exports = { createPlayProtocol, packageName, versionCode, ARCHITECTURES, ANDROID_SDKS, profile, fields, field, message, payload, parseApp, parseApps, parseDelivery, request, headers };
