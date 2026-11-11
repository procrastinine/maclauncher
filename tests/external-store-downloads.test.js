// Required first: it replaces the network before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Downloads = require("../src/modules/shared/runtime/upstream-transport");
const Python = require("../src/modules/shared/runtime/python");
const { createExternalStoreDownloads, normalizeGogVersions, codeFromInput, findSession } = require("../src/core/external-store-downloads");
const fileBytes = Buffer.from("offline game installer"), checksum = crypto.createHash("md5").update(fileBytes).digest("hex");
const product = { title: "Sample game", downloads: { installers: [
  { id: "windows_en", os: "windows", language: "en", version: "2.0", files: [{ id: "part1", size: fileBytes.length, downlink: "https://api.gog.com/downlink/part1" }, { id: "part2", size: fileBytes.length, downlink: "https://api.gog.com/downlink/part2" }] },
  { id: "mac_en", os: "mac", language: "en", version: "1.0", files: [{ id: "mac1", size: fileBytes.length, downlink: "https://api.gog.com/downlink/mac1" }] }
] } };
async function until(check) { for (let n = 0; n < 200; n++) { const result = check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("Timed out waiting for store state"); }
// GOG's services answer through the shared transport; `extra.request` and
// `extra.transfer` replace the default answers and file transfers.
function fixture(t, store, { request, transfer, ...extra } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-download-test-")); let requests = [];
  const answer = async url => {
    requests.push(url); const request = new URL(url); let value;
    if (request.pathname === "/token") value = { access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 };
    else if (request.pathname === "/userData.json") value = { username: "sample" };
    else if (request.pathname === "/account/getFilteredProducts") value = { totalPages: 1, products: [{ id: "710000", title: "Sample game", worksOn: { Windows: true, Mac: true } }] };
    // The second part's CDN path has no file name; its checksum record names it.
    else if (request.pathname.includes("/downlink/")) value = request.pathname.endsWith("part2") ? { downlink: "https://gog-cdn.example.net/secure/part2-token", checksum: "https://gog-cdn.example.net/checksum-part2.xml" }
      : { downlink: `https://cdn.gog.com/${request.pathname.endsWith("part1") ? "setup.exe" : "setup.pkg"}`, checksum: "https://cdn.gog.com/checksum.xml" };
    else if (request.pathname === "/checksum.xml") return { status: 200, body: Buffer.from(`<file md5="${checksum}" total_size="${fileBytes.length}"/>`) };
    else if (request.pathname === "/checksum-part2.xml") return { status: 200, body: Buffer.from(`<file name="setup-1.bin" md5="${checksum}" total_size="${fileBytes.length}"><chunk md5="${"0".repeat(32)}"/></file>`) };
    else if (request.hostname === "content-system.gog.com") value = { items: (extra.builds || []).filter(item => item.os === (request.pathname.includes("/os/windows/") ? "windows" : "osx")) };
    else if (request.pathname.startsWith("/products/")) value = product;
    else throw new Error("Unexpected request: " + request.pathname);
    return { status: 200, body: Buffer.from(JSON.stringify(value)) };
  };
  const downloads = [];
  t.mock.method(Downloads, "fetchUrlBuffer", request || answer);
  t.mock.method(Downloads, "downloadToFile", transfer || (async (url, output, options) => {
    downloads.push({ url, output }); fs.writeFileSync(output, fileBytes); options.onProgress?.({ downloaded: fileBytes.length, total: fileBytes.length });
    return { downloaded: fileBytes.length, total: fileBytes.length };
  }));
  const service = createExternalStoreDownloads({ store, userDataDir: root, homeDir: root, ...extra });
  t.after(async () => { await service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, service, requests, downloads };
}
async function connectGog(service) { await service.connect({ mode: "manual" }); await service.submitAuth({ code: "sample-code" }); await until(() => service.snapshot().library.length === 1 && !service.snapshot().libraryLoading); }
test("external windows are offline until explicit connect and browser codes are parsed safely", async t => {
  const { service, requests } = fixture(t, "gog"); assert.equal(requests.length, 0); assert.equal(service.snapshot().connection.status, "disconnected");
  const state = await service.connect({ mode: "manual" }); assert.equal(requests.length, 0); assert.equal(state.connection.status, "guard"); assert.equal(new URL(state.connection.authUrl).hostname, "auth.gog.com");
  assert.equal(codeFromInput("https://embed.gog.com/on_login_success?code=one-use-code"), "one-use-code");
  assert.equal(codeFromInput('{"authorizationCode":"epic-code"}'), "epic-code"); assert.throws(() => codeFromInput("https://example.com/no-code"));
});
test("GOG exposes real OS/version choices and downloads every multipart installer to a separate custom folder", async t => {
  let imports = 0; const { root, service, downloads } = fixture(t, "gog", { onDownloaded: async () => { imports++; } }); await connectGog(service);
  const versions = await service.getVersions("710000"); assert.deepEqual(versions.platforms, ["windows", "macos"]); assert.equal(versions.branches.length, 2);
  const chosen = path.join(root, "chosen"); fs.mkdirSync(chosen); fs.writeFileSync(path.join(chosen, "preserve"), "existing");
  const job = service.download({ appId: "710000", platform: "windows", branch: versions.branches.find(row => row.name === "2.0").id, destination: chosen, autoImport: false, language: "en" });
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && ["completed", "error"].includes(row.status)));
  assert.equal(result.status, "completed", result.error); assert.equal(imports, 0); assert.equal(downloads.length, 2);
  assert.deepEqual(downloads.map(item => item.url), ["https://cdn.gog.com/setup.exe", "https://gog-cdn.example.net/secure/part2-token"]);
  assert.equal(path.basename(result.importPath), "setup.exe"); assert.equal(fs.existsSync(path.join(result.path, "setup-1.bin")), true); assert.equal(fs.readFileSync(path.join(chosen, "preserve"), "utf8"), "existing");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "external/installations.json")))[0].complete, true);
  assert.equal(JSON.stringify(service.snapshot()).includes("fixture-access"), false); assert.equal(JSON.stringify(service.snapshot()).includes("fixture-refresh"), false);
});
test("GOG rejects an installer whose bytes differ from its published MD5 and size", async t => {
  const { service } = fixture(t, "gog", { transfer: async (_url, output) => { fs.writeFileSync(output, Buffer.from("changed installer bytes")); } });
  await connectGog(service); const versions = await service.getVersions("710000");
  const job = service.download({ appId: "710000", platform: "windows", branch: versions.branches.find(row => row.name === "2.0").id, autoImport: false, language: "en" });
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && ["completed", "error"].includes(row.status)));
  assert.equal(result.status, "error"); assert.match(result.error, /integrity/); assert.equal(fs.existsSync(result.path), false);
});
test("GOG rejects a version for the wrong platform instead of downloading another version", async t => {
  const { service, downloads } = fixture(t, "gog"); await connectGog(service); const versions = await service.getVersions("710000");
  const job = service.download({ appId: "710000", platform: "macos", branch: versions.branches.find(row => row.name === "2.0").id, language: "en" });
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && row.status === "error")); assert.match(result.error, /no GOG installer/); assert.equal(downloads.length, 0);
});
test("Epic reuses credentials read-only and sends the selected historical manifest to Legendary", async t => {
  const commands = [], original = { access_token: "epic-fixture-access", refresh_token: "epic-fixture-refresh", displayName: "sample" };
  const { root, service } = fixture(t, "epic", { findSession: () => original, ensureLegendary: async () => ({ pythonPath: "/fixture/python", packagesPath: "/fixture/packages" }),
    execute: async (_command, _args, options) => {
      const args = JSON.parse(options.input).args; commands.push(args);
      if (args.includes("list")) return { stdout: JSON.stringify([{ app_name: "SampleGame", app_title: "Sample game", asset_infos: { Windows: { build_version: "build-2" }, Mac: { build_version: "build-1" } } }]) };
      if (args.includes("info")) return { stdout: JSON.stringify({ manifest: { build_version: args.at(-1) === "Mac" ? "build-1" : "build-2", download_size: 22 } }) };
      if (args.includes("install")) { const base = args[args.indexOf("--base-path") + 1]; fs.writeFileSync(path.join(base, "content/game.exe"), fileBytes); }
      return { stdout: "{}" };
    } });
  await service.connect({ mode: "reuse" }); await until(() => service.snapshot().library.length === 1); const versions = await service.getVersions("SampleGame");
  assert.equal(versions.supportsManifestOverride, true); assert.deepEqual(versions.branches.map(row => row.name), ["build-2", "build-1"]);
  const job = service.download({ appId: "SampleGame", platform: "windows", branch: "windows", manifestUrl: "https://epicgames-download1.akamaized.net/previous.manifest", autoImport: false });
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && ["completed", "error"].includes(row.status)));
  assert.equal(result.status, "completed", result.error); const command = commands.find(args => args.includes("install"));
  assert.equal(command[command.indexOf("--manifest") + 1], "https://epicgames-download1.akamaized.net/previous.manifest"); assert.ok(command.includes("--download-only"));
  assert.equal(original.refresh_token, "epic-fixture-refresh"); assert.equal(fs.existsSync(path.join(root, "external/epic/user.json")), false);
});
test("GOG sessions are discovered without modifying Heroic or gog-cli files", t => {
  const { root } = fixture(t, "gog"), auth = path.join(root, "Library/Application Support/heroic/gog_store/auth.json"); fs.mkdirSync(path.dirname(auth), { recursive: true });
  const content = JSON.stringify({ "46899977096215655": { access_token: "fixture-access", refresh_token: "fixture-refresh" } }); fs.writeFileSync(auth, content);
  assert.equal(findSession("gog", root).refresh_token, "fixture-refresh"); assert.equal(fs.readFileSync(auth, "utf8"), content);
  assert.equal(normalizeGogVersions("710000", product).branches.length, 2);
});
test("store cancellation removes partial data and preserves an existing destination", async t => {
  let started = false; const { root, service } = fixture(t, "gog", { transfer: async (_url, output, { signal }) => { started = true; fs.writeFileSync(output, "partial"); await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); } });
  await connectGog(service); const job = service.download({ appId: "710000", platform: "windows", autoImport: false }); await until(() => started); service.cancel(job.id);
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && row.status === "cancelled")); assert.equal(fs.existsSync(result.path), false); assert.deepEqual(fs.readdirSync(path.dirname(result.path)), []);
});
test("GOG enumerates historical Galaxy builds and passes the exact selected build to gogdl", async t => {
  const commands = []; const { service } = fixture(t, "gog", {
    builds: [{ build_id: "11111111111111111", version_name: "1.0", os: "windows", public: true, date_published: "2020-01-01T00:00:00Z", generation: 2 },
      { build_id: "22222222222222222", version_name: "2.0", os: "windows", public: true, date_published: "2021-01-01T00:00:00Z", generation: 2 }],
    ensureGogdl: async () => ({ executablePath: "/fixture/gogdl", version: "1.3.1" }),
    execute: async (_command, args, execution) => { commands.push(args); assert.ok(execution.env.GOGDL_CONFIG_PATH.startsWith(execution.cwd + path.sep)); fs.writeFileSync(path.join(execution.env.GOGDL_CONFIG_PATH, "fixture-cache"), "private"); fs.writeFileSync(path.join(args[args.indexOf("--path") + 1], "game.exe"), fileBytes); return { stdout: "" }; }
  });
  await connectGog(service); const versions = await service.getVersions("710000"), previous = versions.branches.find(row => row.buildId === "11111111111111111");
  assert.equal(previous.delivery, "galaxy"); assert.deepEqual(previous.platforms, ["windows"]);
  const job = service.download({ appId: "710000", platform: "windows", branch: previous.id, autoImport: false, language: "en" });
  const result = await until(() => service.snapshot().downloads.find(row => row.id === job.id && ["completed", "error"].includes(row.status)));
  assert.equal(result.status, "completed", result.error); assert.equal(commands[0][commands[0].indexOf("--build") + 1], "11111111111111111");
  assert.equal(fs.existsSync(path.join(result.path, "game.exe")), true); assert.equal(result.branch, previous.id);
  const metadata = JSON.parse(fs.readFileSync(path.join(result.path, ".maclauncher-external.json")));
  assert.equal(metadata.buildId, "11111111111111111"); assert.equal(metadata.versionName, "1.0"); assert.equal(metadata.importPath, result.path);
});
test("GOG retries an expired reused session once and never forwards account auth through redirects", async t => {
  let profiles = 0, refreshes = 0; const authHeaders = [];
  const { service } = fixture(t, "gog", { findSession: () => ({ access_token: "expired-fixture", refresh_token: "refresh-fixture" }), request: async (url, options) => {
    const endpoint = new URL(url); let value;
    if (endpoint.pathname === "/token") { refreshes++; assert.equal(endpoint.searchParams.get("grant_type"), "refresh_token"); assert.equal(endpoint.searchParams.get("refresh_token"), "refresh-fixture"); value = { access_token: "renewed-fixture", refresh_token: "renewed-refresh", expires_in: 3600 }; }
    else { assert.equal(options.maxRedirects, 0); authHeaders.push(options.headers.Authorization); }
    if (endpoint.pathname === "/userData.json") { profiles++; if (profiles === 1) return { status: 401, body: Buffer.from('{"error":"expired"}') }; value = { username: "sample" }; }
    if (endpoint.pathname === "/account/getFilteredProducts") value = { products: [], totalPages: 1 };
    return { status: 200, body: Buffer.from(JSON.stringify(value)) };
  } });
  await service.connect({ mode: "reuse" }); await until(() => !service.snapshot().libraryLoading);
  assert.equal(refreshes, 1); assert.equal(profiles, 2); assert.equal(authHeaders[0], "Bearer expired-fixture"); assert.equal(authHeaders[1], "Bearer renewed-fixture"); assert.equal(service.snapshot().connection.status, "connected");
});
test("GOG rejects invalid OAuth responses instead of displaying an empty connected account", async t => {
  const { service } = fixture(t, "gog", { request: async () => ({ status: 200, body: Buffer.from('{"error":"invalid_grant"}') }) });
  await service.connect({ mode: "manual" }); await assert.rejects(service.submitAuth({ code: "invalid-code" }), /not accepted/); assert.equal(service.snapshot().connection.status, "error");
});
test("GOG default duplicates skip offline transfer and Galaxy setup while custom downloads remain separate", async t => {
  let prompts = 0, setups = 0; const { root, service, downloads } = fixture(t, "gog", {
    builds: [{ build_id: "11111111111111111", version_name: "1.0", os: "windows", public: true, generation: 2 }],
    confirmDuplicate: async () => { prompts++; return "use-existing"; },
    ensureGogdl: async () => { setups++; return { executablePath: "/fixture/gogdl" }; },
    execute: async (_command, args) => { fs.writeFileSync(path.join(args[args.indexOf("--path") + 1], "game.exe"), fileBytes); return { stdout: "" }; }
  });
  await connectGog(service); const catalog = await service.getVersions("710000"), offline = catalog.branches.find(row => row.delivery === "offline" && row.platforms.includes("windows")), galaxy = catalog.branches.find(row => row.delivery === "galaxy");
  const wait = job => until(() => service.snapshot().downloads.find(row => row.id === job.id && ["completed", "error"].includes(row.status)));
  const first = await wait(service.download({ appId: "710000", platform: "windows", branch: offline.id, language: "en", autoImport: false }));
  const reused = await wait(service.download({ appId: "710000", platform: "windows", branch: offline.id, language: "en", autoImport: false }));
  assert.equal(first.status, "completed", first.error); assert.equal(reused.path, first.path); assert.equal(reused.reused, true); assert.equal(downloads.length, 2);
  assert.equal(reused.importPath, path.join(first.path, "setup.exe"));
  const native = await wait(service.download({ appId: "710000", platform: "windows", branch: galaxy.id, autoImport: false }));
  const nativeReused = await wait(service.download({ appId: "710000", platform: "windows", branch: galaxy.id, autoImport: false }));
  assert.equal(native.status, "completed", native.error); assert.equal(nativeReused.path, native.path); assert.equal(setups, 1); assert.equal(prompts, 2);
  const french = await wait(service.download({ appId: "710000", platform: "windows", branch: galaxy.id, language: "fr", autoImport: false }));
  assert.equal(french.status, "completed", french.error); assert.notEqual(french.path, native.path); assert.equal(setups, 2); assert.equal(prompts, 2);
  const custom = await wait(service.download({ appId: "710000", platform: "windows", branch: galaxy.id, destination: path.join(root, "custom"), autoImport: false }));
  assert.equal(custom.status, "completed", custom.error); assert.notEqual(custom.path, native.path); assert.equal(setups, 3); assert.equal(prompts, 2);
});
test("Epic duplicate identity uses the actual manifest build ID and skips another install", async t => {
  let installs = 0, prompts = 0;
  const { service } = fixture(t, "epic", { findSession: () => ({ access_token: "epic-fixture-access", refresh_token: "epic-fixture-refresh", displayName: "sample" }),
    confirmDuplicate: async () => { prompts++; return "use-existing"; }, ensureLegendary: async () => ({ pythonPath: "/fixture/python", packagesPath: "/fixture/packages" }),
    execute: async (_command, _args, options) => {
      const request = JSON.parse(options.input), args = request.args;
      if (args.includes("list")) return { stdout: JSON.stringify([{ app_name: "SampleGame", app_title: "Sample game", asset_infos: { Windows: { build_version: "same-version-name" } } }]) };
      if (args.includes("info")) return { stdout: JSON.stringify({ manifest: { build_version: "same-version-name", build_id: "opaque-content-id" } }) };
      if (args.includes("install")) {
        installs++; assert.equal(request.expectedManifestBuildId, "opaque-content-id");
        fs.writeFileSync(path.join(args[args.indexOf("--base-path") + 1], "content/game.exe"), fileBytes);
        fs.writeFileSync(request.recordPath, JSON.stringify({ version: "same-version-name", buildId: "opaque-content-id" }));
      }
      return { stdout: "{}" };
    } });
  await service.connect({ mode: "reuse" }); await until(() => service.snapshot().library.length === 1); await service.getVersions("SampleGame");
  const wait = job => until(() => service.snapshot().downloads.find(row => row.id === job.id && ["completed", "error"].includes(row.status)));
  const selection = { appId: "SampleGame", platform: "windows", branch: "windows", autoImport: false }, first = await wait(service.download(selection)), second = await wait(service.download(selection));
  assert.equal(first.status, "completed", first.error); assert.equal(second.reused, true); assert.equal(second.path, first.path); assert.equal(installs, 1); assert.equal(prompts, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.path, ".maclauncher-external.json"))).versionId, "manifest:opaque-content-id:windows");
});

// --- Legendary from PyPI -------------------------------------------------------

const PYTHON = Python.resolveEmbeddedPythonBinary(Python.resolveEmbeddedPythonRoot());
// A wheel with the given files and requirements, built with the included Python.
function wheel(directory, name, version, files, requires = [], tag = "py3-none-any") {
  const filename = `${name.replace(/-/g, "_")}-${version}-${tag}.whl`, output = path.join(directory, filename);
  const entries = { ...files, [`${name.replace(/-/g, "_")}-${version}.dist-info/METADATA`]: ["Metadata-Version: 2.1", `Name: ${name}`, `Version: ${version}`,
    ...requires.map(line => `Requires-Dist: ${line}`), ""].join("\n") };
  execFileSync(PYTHON, ["-I", "-c", "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n    for k,v in json.loads(sys.argv[2]).items(): z.writestr(k,v)", output, JSON.stringify(entries)]);
  return { filename, bytes: fs.readFileSync(output) };
}
// PyPI's JSON for a project: every release with its files, sizes and SHA-256.
function pypi(project, releases) {
  const routes = {}, document = { info: { name: project, version: releases.at(-1)?.version }, releases: {} };
  for (const { version, wheels, sdist } of releases) {
    document.releases[version] = [...wheels, ...(sdist ? [{ filename: `${project}-${version}.tar.gz`, bytes: Buffer.from("sdist") }] : [])].map(item => {
      const url = `https://files.pythonhosted.org/packages/${project}/${item.filename}`; routes[url] = item.bytes;
      return { filename: item.filename, url, size: item.bytes.length, digests: { sha256: crypto.createHash("sha256").update(item.bytes).digest("hex") },
        requires_python: item.requiresPython || null, yanked: false, upload_time_iso_8601: "2026-01-01T00:00:00Z" };
    });
  }
  routes[`https://pypi.org/pypi/${project}/json`] = document;
  return routes;
}
function legendaryWheel(directory, version, { hooks = true, requires = ["requests<3.0", "filelock", 'pywebview>=3.4; extra == "webview"'] } = {}) {
  return wheel(directory, "legendary-gl", version, { "legendary/__init__.py": `__version__='${version}'\n`,
    "legendary/core.py": `class LegendaryCore:\n    def get_cdn_manifest(self): pass\n${hooks ? "    def get_uri_manifest(self): pass\n" : ""}    def load_manifest(self, data): pass\n`,
    "legendary/cli.py": `import requests, filelock\nif __name__ == '__main__':\n    print('legendary version ${version}')\n` }, requires);
}
function freshModule() {
  delete require.cache[require.resolve("../src/core/external-store-downloads")];
  return require("../src/core/external-store-downloads");
}
test("Legendary follows PyPI's newest release, resolves its own requirements to compatible wheels and keeps working offline", { skip: !PYTHON && 'Requires the embedded Python in src/resources/python (npm run test:setup)' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "legendary-pypi-test-")), wheels = path.join(root, "wheels"); fs.mkdirSync(wheels);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, "profile"), pkg = name => ({ [`${name}/__init__.py`]: "" });
  const dependencies = {
    ...pypi("requests", [{ version: "2.40.0", wheels: [wheel(wheels, "requests", "2.40.0", pkg("requests"), ["idna>=2.5", 'PySocks!=1.5.7; extra == "socks"'])] },
      { version: "3.0.0", wheels: [wheel(wheels, "requests", "3.0.0", pkg("requests"))] }]),
    ...pypi("filelock", [{ version: "4.0.0", wheels: [wheel(wheels, "filelock", "4.0.0", pkg("filelock"))], sdist: true },
      { version: "5.0.0", wheels: [wheel(wheels, "filelock", "5.0.0", pkg("filelock"), [], "cp399-cp399-win_amd64")] }]),
    ...pypi("idna", [{ version: "3.20", wheels: [wheel(wheels, "idna", "3.20", pkg("idna"))] }])
  };
  const ensure = async (module, routes) => {
    const start = Harness.network.requests.length; Harness.network.routes = routes;
    try { return { ...(await module.ensureLegendary({ userDataDir, pythonPath: PYTHON })), requests: Harness.network.requests.slice(start) }; }
    finally { Harness.network.routes = null; }
  };
  const first = await ensure(freshModule(), { ...dependencies, ...pypi("legendary-gl", [{ version: "0.21.1", wheels: [legendaryWheel(wheels, "0.21.1")] },
    { version: "0.21.2", wheels: [legendaryWheel(wheels, "0.21.2")] }]) });
  const receipt = JSON.parse(fs.readFileSync(path.join(first.packagesPath, ".maclauncher-tools.json"), "utf8"));
  assert.equal(receipt.legendaryVersion, "0.21.2"); assert.equal(receipt.confirmsBuilds, true);
  assert.deepEqual(receipt.packages.map(item => `${item.name} ${item.version}`), ["legendary-gl 0.21.2", "requests 2.40.0", "filelock 4.0.0", "idna 3.20"]);
  assert.ok(receipt.packages.every(item => item.integrity === "publisher-sha256" && /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.equal(first.requests.some(url => /pywebview|pysocks/i.test(url)), false, "optional extras are not installed");
  assert.ok(fs.existsSync(path.join(first.packagesPath, "idna", "__init__.py")));
  // The same session asks PyPI once; a later session without a connection keeps the installation.
  const module = freshModule();
  assert.equal((await ensure(module, {})).packagesPath, first.packagesPath);
  assert.equal((await ensure(module, {})).requests.length, 0);
  // A newer release without the manifest lookups yields to the installed one that has them.
  const later = await ensure(freshModule(), { ...dependencies, ...pypi("legendary-gl", [{ version: "0.21.2", wheels: [legendaryWheel(wheels, "0.21.2")] },
    { version: "0.22.0", wheels: [legendaryWheel(wheels, "0.22.0", { hooks: false })] }]) });
  assert.equal(later.packagesPath, first.packagesPath);
  const added = fs.readdirSync(path.join(userDataDir, "external", "tools")).find(name => name.startsWith("legendary-0.22.0-"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(userDataDir, "external", "tools", added, ".maclauncher-tools.json"), "utf8")).confirmsBuilds, false);
  // A wheel whose bytes differ from PyPI's SHA-256 is not installed.
  const changed = { ...dependencies, ...pypi("legendary-gl", [{ version: "0.23.0", wheels: [legendaryWheel(wheels, "0.23.0")] }]) };
  changed[Object.keys(changed).find(url => url.endsWith("legendary_gl-0.23.0-py3-none-any.whl"))] = Buffer.from("changed");
  fs.rmSync(path.join(userDataDir, "external", "tools"), { recursive: true });
  await assert.rejects(ensure(freshModule(), changed), /size|checksum/);
  assert.deepEqual(fs.readdirSync(path.join(userDataDir, "external", "tools")), []);
});
