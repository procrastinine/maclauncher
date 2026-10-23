const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { createItchStoreDownloads } = require("../src/core/itch-store-downloads");
const { parsePublicItchPage } = require("../src/core/itch-public-games");

const API_KEY = "example-private-key-0123456789";
const oldArchive = Buffer.from("old ZIP");
const oldHash = crypto.createHash("sha256").update(oldArchive).digest("hex");
const profile = { user: { id: 10, username: "example-account", display_name: "Example Player" } };
const owned = { id: 501, game_id: 100, game: { id: 100, title: "Example Game", traits: ["p_windows", "p_osx"], url: "https://example.itch.io/game" } };
const builds = [{ id: 700, version: 2, user_version: "2.0", state: "completed", files: [{ type: "archive", state: "uploaded", size: 7 }] },
  { id: 600, version: 1, user_version: "1.0", state: "completed", files: [{ type: "archive", state: "uploaded", size: 7, sha256: oldHash }] }];
const uploads = [{ id: 20, storage: "build", filename: "windows.zip", display_name: "Windows", build_id: 700, platforms: { windows: "all" } },
  { id: 30, storage: "hosted", filename: "mac.zip", display_name: "Mac", size: 7, traits: ["p_osx"] }];
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
function fixture(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "itch-downloads-")); t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true })); return { userDataDir };
}
function transport(handler, requests = []) {
  return async (url, options = {}) => {
    const address = new URL(url); requests.push({ url, options });
    assert.equal(address.searchParams.has("api_key"), false); assert.equal(String(url).includes(API_KEY), false);
    if (address.origin === "https://api.itch.io") assert.equal(options.headers.Authorization, `Bearer ${API_KEY}`);
    const custom = await handler?.(address, options); if (custom) return custom;
    if (address.pathname === "/profile") return json(profile);
    if (address.pathname === "/profile/owned-keys") return json({ owned_keys: address.searchParams.get("page") === "1" ? [owned] : [] });
    if (address.pathname === "/games/100/uploads") return json({ uploads });
    if (address.pathname === "/uploads/20/builds") return json({ builds });
    assert.fail(`Unexpected itch.io request ${address.pathname}`);
  };
}
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 300; attempt++) { const value = predicate(); if (value) return value; await delay(5); }
  assert.fail("The expected itch.io action did not finish.");
}
function findFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? findFiles(path.join(root, entry.name)) : [path.join(root, entry.name)]);
}

test("itch connection stays offline until explicit action and lists owned purchases across short pages", async t => {
  const f = fixture(t), requests = [], saved = [];
  const fetch = transport(address => {
    if (address.pathname !== "/profile/owned-keys") return;
    const page = Number(address.searchParams.get("page"));
    return json({ owned_keys: page === 1 ? [owned] : page === 2 ? [{ ...owned, id: 502 }, { id: 503, game_id: 101, game: { id: 101, title: "Other Game", traits: ["p_linux"] } }] : [] });
  }, requests);
  const service = createItchStoreDownloads({ ...f, fetch, saveSession: value => saved.push(value) }); t.after(() => service.dispose());
  await delay(1); assert.equal(requests.length, 0);
  const state = await service.connect({ mode: "manual", apiKey: API_KEY });
  assert.equal(state.connection.status, "connected"); assert.equal(state.library.length, 2);
  assert.deepEqual(requests.filter(item => new URL(item.url).pathname === "/profile/owned-keys").map(item => new URL(item.url).searchParams.get("page")), ["1", "2", "3"]);
  assert.equal(requests.some(item => /my-games|profile\/games/.test(item.url)), false);
  assert.deepEqual(saved, [], "API keys are not saved by default");
  assert.equal(JSON.stringify(state).includes(API_KEY), false);
  assert.ok(findFiles(f.userDataDir).every(file => !fs.readFileSync(file, "utf8").includes(API_KEY)));
});

test("API key saving uses only the host adapter and saved keys can be reused or forgotten", async t => {
  const f = fixture(t); let saved = null; const writes = [];
  const service = createItchStoreDownloads({ ...f, fetch: transport(), loadSession: () => saved,
    saveSession: value => { saved = value; writes.push(value); } }); t.after(() => service.dispose());
  await service.connect({ apiKey: API_KEY, remember: true }); assert.equal(writes.length, 1); assert.equal(writes[0].apiKey, API_KEY);
  assert.equal(service.snapshot().hasSavedKey, true); service.disconnect();
  await service.connect({ mode: "reuse" }); assert.equal(service.snapshot().connection.status, "connected"); assert.equal(writes.length, 1);
  await service.forgetSession(); assert.equal(saved, null); assert.equal(service.snapshot().hasSavedKey, false);
  assert.equal(service.snapshot().connection.status, "disconnected");
  await assert.rejects(service.connect({ mode: "reuse" }), /valid itch.io API key/);
  let finishRead;
  const delayed = createItchStoreDownloads({ userDataDir: path.join(f.userDataDir, "delayed"), fetch: transport(),
    loadSession: () => new Promise(resolve => { finishRead = resolve; }), saveSession() {} }); t.after(() => delayed.dispose());
  await waitFor(() => finishRead); await delayed.forgetSession(); finishRead({ apiKey: API_KEY }); await delay(1);
  assert.equal(delayed.snapshot().hasSavedKey, false, "A stale storage read cannot undo Forget saved key");
});

test("uploads expose exact historical build choices and download the selected archive into a custom folder", async t => {
  const f = fixture(t), requests = [], imported = [];
  const service = createItchStoreDownloads({ ...f, fetch: transport((address, options) => {
    if (address.pathname === "/builds/600/download/archive/default") {
      assert.equal(address.searchParams.get("download_key_id"), "501");
      return new Response(null, { status: 302, headers: { location: "https://cdn.itch.zone/selected.zip?signature=example" } });
    }
    if (address.origin === "https://cdn.itch.zone") {
      assert.equal(options.headers.Authorization, undefined, "The account key never reaches a download host");
      return new Response(oldArchive, { headers: { "content-length": "7", "content-type": "application/zip" } });
    }
  }, requests), onDownloaded: job => imported.push(job.importPath) }); t.after(() => service.dispose());
  await service.connect({ apiKey: API_KEY });
  const catalog = await service.getVersions(100);
  assert.deepEqual(catalog.branches.map(branch => branch.id), ["20:700", "20:600", "30:file"]);
  assert.equal(JSON.stringify(catalog).includes("download_key_id"), false);
  const before = requests.length; await service.getVersions(100); assert.equal(requests.length, before, "Opening a cached version does not query itch.io again");
  const destination = path.join(f.userDataDir, "Chosen Downloads");
  const queued = service.download({ appId: 100, platform: "windows", branch: "20:600", destination });
  await waitFor(() => service.snapshot().downloads.find(job => job.id === queued.id)?.status === "completed");
  await waitFor(() => imported.length === 1);
  const completed = service.snapshot().downloads.find(job => job.id === queued.id);
  assert.equal(path.dirname(completed.path), fs.realpathSync(destination)); assert.equal(completed.downloaded, 7);
  assert.deepEqual(fs.readFileSync(completed.importPath), oldArchive); assert.deepEqual(imported, [completed.importPath]);
  const metadata = JSON.parse(fs.readFileSync(path.join(completed.path, ".maclauncher-external.json"), "utf8"));
  assert.equal(metadata.buildId, "600"); assert.equal(metadata.uploadId, "20"); assert.equal(metadata.sha256, oldHash); assert.equal(metadata.complete, true);
  assert.equal(JSON.stringify(metadata).includes(API_KEY), false); assert.equal(JSON.stringify(metadata).includes("signature"), false);
  assert.equal(requests.some(item => item.url.includes("/builds/700/download")), false);
});

test("missing requested versions fail explicitly and cancellation removes unpublished data", async t => {
  const f = fixture(t); let streaming = false;
  const service = createItchStoreDownloads({ ...f, fetch: transport((address, options) => {
    if (address.pathname !== "/builds/600/download/archive/default") return;
    streaming = true;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from("partial")); options.signal.addEventListener("abort", () => controller.error(Object.assign(new Error("Cancelled"), { name: "AbortError" })), { once: true });
    } }), { headers: { "content-type": "application/zip" } });
  }) }); t.after(() => service.dispose());
  await service.connect({ apiKey: API_KEY }); await service.getVersions(100);
  const absent = service.download({ appId: 100, platform: "windows", branch: "20:missing" });
  await waitFor(() => service.snapshot().downloads.find(job => job.id === absent.id)?.status === "error");
  assert.match(service.snapshot().downloads.find(job => job.id === absent.id).error, /available itch.io upload and version/);
  const active = service.download({ appId: 100, platform: "windows", branch: "20:600" }); await waitFor(() => streaming);
  service.cancel(active.id); await waitFor(() => service.snapshot().downloads.find(job => job.id === active.id)?.status === "cancelled");
  assert.equal(fs.existsSync(path.join(f.userDataDir, "external/installations.json")), false);
  assert.equal(findFiles(path.join(f.userDataDir, "external/downloads/itch")).length, 0);
});

test("API failures and unsafe credential redirects do not expose key material or fall back to another version", async t => {
  const f = fixture(t), requests = [];
  const service = createItchStoreDownloads({ ...f, fetch: transport(address => {
    if (address.pathname === "/builds/600/download/archive/default") return new Response(null, { status: 302, headers: { location: `https://cdn.itch.zone/file.zip?api_key=${API_KEY}` } });
  }, requests) }); t.after(() => service.dispose());
  await service.connect({ apiKey: API_KEY }); const job = service.download({ appId: 100, platform: "windows", branch: "20:600" });
  await waitFor(() => service.snapshot().downloads.find(item => item.id === job.id)?.status === "error");
  assert.match(service.snapshot().downloads[0].error, /account credentials/); assert.equal(JSON.stringify(service.snapshot()).includes(API_KEY), false);
  assert.equal(requests.some(item => new URL(item.url).origin !== "https://api.itch.io"), false);
  assert.equal(requests.some(item => item.url.includes("/builds/700/download")), false);
  const denied = createItchStoreDownloads({ userDataDir: path.join(f.userDataDir, "other"), fetch: async () => new Response(JSON.stringify({ errors: [API_KEY] }), { status: 403 }) }); t.after(() => denied.dispose());
  await denied.connect({ apiKey: API_KEY }); assert.equal(denied.snapshot().connection.status, "error"); assert.equal(JSON.stringify(denied.snapshot()).includes(API_KEY), false);
});

test("repeating an exact default download prompts before reusing it while custom copies remain explicit", async t => {
  const f = fixture(t), confirmations = [], imported = []; let transfers = 0, decision = "use-existing";
  const service = createItchStoreDownloads({ ...f, fetch: transport(address => {
    if (address.pathname === "/builds/600/download/archive/default") { transfers++; return new Response(oldArchive, { headers: { "content-type": "application/zip", "content-length": "7" } }); }
  }), confirmDuplicate: existing => { confirmations.push(existing); return decision; }, onDownloaded: job => imported.push(job.importPath) });
  t.after(() => service.dispose()); await service.connect({ apiKey: API_KEY });
  const selection = { appId: 100, platform: "windows", branch: "20:600", autoImport: false };
  const first = service.download(selection);
  const completed = await waitFor(() => service.snapshot().downloads.find(job => job.id === first.id && job.status === "completed"));
  const repeated = service.download({ ...selection, autoImport: true });
  const reused = await waitFor(() => service.snapshot().downloads.find(job => job.id === repeated.id && job.status === "completed"));
  await waitFor(() => imported.length === 1);
  assert.equal(transfers, 1); assert.equal(confirmations.length, 1); assert.equal(reused.path, completed.path); assert.equal(reused.reused, true);
  assert.deepEqual(imported, [completed.importPath]); assert.equal(reused.downloaded, 7);
  const indexPath = path.join(f.userDataDir, "external/installations.json");
  assert.equal(JSON.parse(fs.readFileSync(indexPath)).length, 1);
  const custom = service.download({ ...selection, destination: path.join(f.userDataDir, "Separate Collection") });
  const copied = await waitFor(() => service.snapshot().downloads.find(job => job.id === custom.id && job.status === "completed"));
  assert.notEqual(copied.path, completed.path); assert.equal(transfers, 2); assert.equal(confirmations.length, 1);
  decision = "cancel"; const cancelled = service.download(selection);
  await waitFor(() => service.snapshot().downloads.find(job => job.id === cancelled.id && job.status === "cancelled"));
  assert.equal(transfers, 2); assert.equal(JSON.parse(fs.readFileSync(indexPath)).length, 2);
  decision = "download-again"; const confirmed = service.download(selection);
  const extra = await waitFor(() => service.snapshot().downloads.find(job => job.id === confirmed.id && job.status === "completed"));
  assert.notEqual(extra.path, completed.path); assert.equal(transfers, 3); assert.equal(confirmations.length, 3);
  const metadata = JSON.parse(fs.readFileSync(path.join(extra.path, ".maclauncher-external.json")));
  assert.equal(metadata.versionId, "20:600"); assert.match(metadata.downloadIdentity, /^[a-f0-9]{64}$/);
});

test("replaced hosted files receive a different exact identity and a stale file selection never downloads newer content", async t => {
  const f = fixture(t); let revision = "2026-10-20T12:00:00Z", transfers = 0, prompts = 0;
  const upload = () => ({ id: 30, storage: "hosted", filename: "mac.zip", display_name: "Mac", size: 7, traits: ["p_osx"], updated_at: revision });
  const service = createItchStoreDownloads({ ...f, fetch: transport(address => {
    if (address.pathname === "/games/100/uploads") return json({ uploads: [upload()] });
    if (address.pathname === "/uploads/30") return json({ upload: upload() });
    if (address.pathname === "/uploads/30/download") { transfers++; return new Response(oldArchive, { headers: { "content-type": "application/zip", "content-length": "7" } }); }
  }), confirmDuplicate: () => { prompts++; return "use-existing"; } }); t.after(() => service.dispose());
  await service.connect({ apiKey: API_KEY }); const firstCatalog = await service.getVersions(100);
  const firstId = firstCatalog.branches[0].id; assert.match(firstId, /^30:file:[a-f0-9]+$/);
  const first = service.download({ appId: 100, platform: "macos", branch: firstId, autoImport: false });
  await waitFor(() => service.snapshot().downloads.find(job => job.id === first.id && job.status === "completed"));
  revision = "2026-10-21T12:00:00Z";
  const stale = service.download({ appId: 100, platform: "macos", branch: firstId, destination: path.join(f.userDataDir, "Custom"), autoImport: false });
  const refused = await waitFor(() => service.snapshot().downloads.find(job => job.id === stale.id && job.status === "error"));
  assert.match(refused.error, /file changed/); assert.equal(transfers, 1);
  const nextCatalog = await service.getVersions(100, { refresh: true }); const nextId = nextCatalog.branches[0].id;
  assert.notEqual(nextId, firstId);
  const next = service.download({ appId: 100, platform: "macos", branch: nextId, autoImport: false });
  await waitFor(() => service.snapshot().downloads.find(job => job.id === next.id && job.status === "completed"));
  assert.equal(transfers, 2); assert.equal(prompts, 0, "An equal-sized replacement is a different file revision");
  revision = null;
  const unversioned = (await service.getVersions(100, { refresh: true })).branches[0];
  assert.equal(unversioned.exactIdentity, false);
  for (let copy = 0; copy < 2; copy++) {
    const job = service.download({ appId: 100, platform: "macos", branch: unversioned.id, autoImport: false });
    await waitFor(() => service.snapshot().downloads.find(item => item.id === job.id && item.status === "completed"));
  }
  assert.equal(transfers, 4); assert.equal(prompts, 0, "Size alone cannot establish that an unversioned upload is identical");
});

const PUBLIC_URL = "https://public.itch.io/game";
function publicPage({ download = false, hidden = false, price = 0 } = {}) {
  return `<html><head><meta content="games/200" name="itch:path"><meta value="${download ? "fresh-csrf" : "initial-csrf"}" name="csrf_token"></head>
    <h1 class="game_title">Public &amp; Free</h1><script>const config = {"min_price":${price}};</script>
    ${hidden ? "" : '<div class="upload"><a class="button download_btn" data-upload_id="40">Download</a><div class="info_column"><strong title="public-windows.zip" class="name">Windows release 1.0</strong><span class="icon icon-windows8"></span></div></div>'}</html>`;
}
function publicTransport(settings = {}, requests = []) {
  return async (value, options = {}) => {
    const url = new URL(value); requests.push({ url: String(value), options });
    assert.equal(options.headers?.Authorization, undefined, "Guest requests never include account credentials");
    assert.notEqual(url.origin, "https://api.itch.io", "Guest downloads use the public website protocol");
    if (url.origin === "https://cdn.itch.zone") {
      assert.equal(options.headers?.Cookie, undefined, "Guest website cookies stay on the game website");
      const etag = settings.etag?.() || '"revision-one"';
      if (options.headers?.Range) return new Response(Buffer.from("o"), { status: 206, headers: { "content-length": "1", "content-range": "bytes 0-0/7", etag } });
      const custom = settings.download?.(options, etag); if (custom) return custom;
      assert.equal(options.headers?.["If-Match"], etag);
      return new Response(oldArchive, { headers: { "content-type": "application/zip", "content-length": "7", etag } });
    }
    assert.equal(url.origin, new URL(PUBLIC_URL).origin);
    if (url.pathname === "/game") return new Response(publicPage({ hidden: settings.hidden, price: settings.price }), { headers: { "content-type": "text/html", "set-cookie": "guest=public-cookie; Secure; HttpOnly" } });
    if (url.pathname === "/game/download_url") {
      assert.equal(options.method, "POST"); assert.equal(new URLSearchParams(options.body).get("csrf_token"), "initial-csrf");
      assert.match(options.headers.Cookie, /guest=public-cookie/); return json({ url: `${PUBLIC_URL}/download/transient-ticket` });
    }
    if (url.pathname === "/game/download/transient-ticket") return new Response(publicPage({ download: true }), { headers: { "content-type": "text/html" } });
    if (url.pathname === "/game/file/40") {
      assert.equal(options.method, "POST"); assert.equal(new URLSearchParams(options.body).get("csrf_token"), "fresh-csrf");
      return json({ external: false, url: "https://cdn.itch.zone/public.zip?signature=temporary-signature" });
    }
    assert.fail(`Unexpected public itch.io request ${url.pathname}`);
  };
}

test("public upload filenames remain inside the download folder", () => {
  for (const [source, expected] of [["../../outside.exe", "outside.exe"], ["C:\\folder\\game.exe", "game.exe"],
    [".maclauncher-external.json", "itch-200-40.zip"], ["..", "itch-200-40.zip"]]) {
    const parsed = parsePublicItchPage(publicPage().replace('title="public-windows.zip"', `title="${source}"`), PUBLIC_URL);
    assert.equal(parsed.uploads[0].filename, expected);
  }
});

test("public itch games connect offline, persist URLs and download exact uploads without a key", async t => {
  const f = fixture(t), requests = []; let prompts = 0;
  const service = createItchStoreDownloads({ ...f, fetch: publicTransport({}, requests), confirmDuplicate: () => { prompts++; return "use-existing"; } });
  t.after(() => service.dispose()); await service.connect({ mode: "public" }); assert.equal(requests.length, 0);
  const added = await service.addGame(PUBLIC_URL); assert.equal(added.connection.mode, "public"); assert.equal(added.library[0].name, "Public & Free");
  assert.deepEqual(added.library[0].platforms, ["windows"]);
  const catalog = await service.getVersions(200), branch = catalog.branches[0];
  assert.equal(branch.exactIdentity, true); assert.match(branch.id, /^40:public:[a-f0-9]+$/); assert.equal(branch.size, 7);
  assert.match(branch.version, /^Upload 40 · [a-f0-9]{12}$/);
  const selection = { appId: 200, platform: "windows", branch: branch.id, autoImport: false };
  const first = service.download(selection), completed = await waitFor(() => service.snapshot().downloads.find(job => job.id === first.id && job.status === "completed"));
  assert.deepEqual(fs.readFileSync(completed.importPath), oldArchive); assert.equal(completed.imported, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(completed.path, ".maclauncher-external.json"), "utf8")).version, branch.version);
  const repeated = service.download(selection); const reused = await waitFor(() => service.snapshot().downloads.find(job => job.id === repeated.id && job.status === "completed"));
  assert.equal(reused.path, completed.path); assert.equal(prompts, 1);
  const destination = path.join(f.userDataDir, "Custom copies"), custom = service.download({ ...selection, destination });
  const copied = await waitFor(() => service.snapshot().downloads.find(job => job.id === custom.id && job.status === "completed"));
  assert.equal(path.dirname(copied.path), fs.realpathSync(destination)); assert.notEqual(copied.path, completed.path);
  assert.equal(requests.filter(request => request.url.startsWith("https://cdn.itch.zone") && !request.options.headers.Range).length, 2);
  for (const file of findFiles(f.userDataDir).filter(file => file.endsWith(".json"))) {
    const text = fs.readFileSync(file, "utf8"); assert.doesNotMatch(text, /temporary-signature|transient-ticket|public-cookie|fresh-csrf|initial-csrf/);
  }
  const restartRequests = [], restarted = createItchStoreDownloads({ ...f, fetch: publicTransport({}, restartRequests) }); t.after(() => restarted.dispose());
  const restored = await restarted.connect({ mode: "public" }); assert.equal(restored.library.length, 1); assert.equal(restartRequests.length, 0);
  assert.equal(fs.existsSync(path.join(f.userDataDir, "external/itch/public/library.json")), true);
});

test("pay-what-you-want discovery preserves exact public revisions and rejects changed files", async t => {
  const f = fixture(t), requests = []; let revision = '"old-file"', fullEtag;
  const service = createItchStoreDownloads({ ...f, fetch: publicTransport({ hidden: true, etag: () => revision,
    download: (_options, etag) => new Response(oldArchive, { headers: { "content-type": "application/zip", "content-length": "7", etag: fullEtag || etag } }) }, requests) });
  t.after(() => service.dispose()); await service.connect({ mode: "public" }); await service.addGame(PUBLIC_URL);
  assert.equal(service.snapshot().library[0].accessRequired, false);
  const first = (await service.getVersions(200)).branches[0]; revision = '"equal-sized-replacement"';
  const stale = service.download({ appId: 200, platform: "windows", branch: first.id, autoImport: false });
  const rejected = await waitFor(() => service.snapshot().downloads.find(job => job.id === stale.id && job.status === "error"));
  assert.match(rejected.error, /file changed/);
  assert.equal(requests.filter(request => request.url.startsWith("https://cdn.itch.zone") && !request.options.headers.Range).length, 0);
  const current = (await service.getVersions(200, { refresh: true })).branches[0]; assert.notEqual(current.id, first.id);
  fullEtag = '"changed-during-transfer"';
  const raced = service.download({ appId: 200, platform: "windows", branch: current.id, autoImport: false });
  const refused = await waitFor(() => service.snapshot().downloads.find(job => job.id === raced.id && job.status === "error"));
  assert.match(refused.error, /file changed/); assert.equal(findFiles(path.join(f.userDataDir, "external/downloads/itch")).length, 0);
  assert.equal(fs.existsSync(path.join(f.userDataDir, "external/installations.json")), false);
});

test("guest access limits are actionable and cancellation removes unpublished public downloads", async t => {
  const f = fixture(t), paidRequests = [];
  const paid = createItchStoreDownloads({ userDataDir: path.join(f.userDataDir, "paid"), fetch: publicTransport({ hidden: true, price: 500 }, paidRequests) });
  t.after(() => paid.dispose()); await paid.connect({ mode: "public" }); await paid.addGame(PUBLIC_URL);
  assert.equal(paid.snapshot().library[0].accessRequired, true); await assert.rejects(paid.getVersions(200), /requires purchase or account access/);
  assert.equal(paidRequests.some(request => request.url.includes("download_url")), false);
  const before = paidRequests.length; await assert.rejects(paid.addGame("https://localhost/game"), /itch.io game page URL/); assert.equal(paidRequests.length, before);
  let streaming = false;
  const service = createItchStoreDownloads({ ...f, fetch: publicTransport({ download: (options, etag) => {
    streaming = true; return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from("part")); options.signal.addEventListener("abort", () => controller.error(Object.assign(new Error("Cancelled"), { name: "AbortError" })), { once: true });
    } }), { headers: { "content-type": "application/zip", etag } });
  } }) }); t.after(() => service.dispose()); await service.connect({ mode: "public" }); await service.addGame(PUBLIC_URL);
  const branch = (await service.getVersions(200)).branches[0]; const queued = service.download({ appId: 200, platform: "windows", branch: branch.id, autoImport: false });
  await waitFor(() => streaming); service.cancel(queued.id);
  await waitFor(() => service.snapshot().downloads.find(job => job.id === queued.id && job.status === "cancelled"));
  assert.equal(findFiles(path.join(f.userDataDir, "external/downloads/itch")).length, 0);
});
