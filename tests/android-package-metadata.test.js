const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Metadata = require("../src/modules/android/package-metadata");
const Runtime = require("../src/modules/android/runtime");
const Reader = require("../src/modules/android/tools/apk-metadata");

test("APK metadata uses its included reader without selecting or installing an Android runtime", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "android-metadata-selection-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const apk = path.join(temporary, "game.apk"); fs.copyFileSync(path.join(__dirname, "fixtures/android-package-metadata/metadata.apk"), apk);
  const entry = { gameId: "game", gamePath: apk }, context = { userDataDir: temporary, settings: {}, locale: "en-US" };
  for (const name of ["resolveSelected", "resolveForLaunch", "resolveSelectedForLaunch"])
    t.mock.method(Runtime, name, () => assert.fail("Package resources are independent of game runtimes"));
  t.mock.method(Reader, "identity", () => "included-reader-v1");
  const failure = new Error("Included reader verification failed"); let inspected = 0;
  t.mock.method(Reader, "inspect", async options => {
    assert.deepEqual(options.sourceApks, [apk]); assert.equal(options.locale, "en-US");
    assert.ok(fs.statSync(options.outputDirectory).isDirectory()); inspected++; throw failure;
  });
  const key = Metadata.metadataCacheKey(entry, context), legacyKey = { ...key }; delete legacyKey.implementation;
  assert.equal(key.reader, "included-reader-v1");
  assert.equal(key.implementation, require("node:crypto").createHash("sha256").update(fs.readFileSync(require.resolve("../src/modules/android/package-metadata"))).digest("hex"));
  assert.notEqual(JSON.stringify(key), JSON.stringify(legacyKey));
  await assert.rejects(Metadata.read(entry, context), error => error === failure);
  assert.equal(inspected, 1);
  assert.equal(fs.existsSync(path.join(temporary, "games/game/icons/android.json")), false);
});

test("An unavailable included reader cannot replace uncached package facts or request a game runtime", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "android-metadata-missing-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const apk = path.join(temporary, "game.apk"); fs.writeFileSync(apk, "uncached package input");
  for (const name of ["resolveSelected", "resolveForLaunch"])
    t.mock.method(Runtime, name, () => assert.fail("Metadata cannot install a game runtime"));
  t.mock.method(Reader, "identity", () => { throw new Error("Included reader missing"); });
  await assert.rejects(Metadata.resolveGameIcon({ gameId: "missing", gamePath: apk }, { userDataDir: temporary }), /Included reader missing/);
  assert.equal(fs.existsSync(path.join(temporary, "games")), false);
});

test("Verified package metadata survives a missing helper only for the same input and locale", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "android-metadata-offline-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const apk = path.join(temporary, "game.apk"); fs.writeFileSync(apk, "original package input");
  const entry = { gameId: "game", gamePath: apk, name: "Custom game name" }, context = { userDataDir: temporary, locale: "en-US" };
  const digest = value => require("node:crypto").createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const directory = path.join(temporary, "games/game/icons"), record = path.join(directory, "android.json"), icon = path.join(directory, "android.png");
  fs.mkdirSync(directory, { recursive: true }); fs.copyFileSync(path.resolve("src/modules/android/resources/icon.png"), icon);
  const prior = { identity: "previous-reader", inputIdentity: digest([Metadata.sourceIdentity(entry), context.locale]),
    icon: true, label: "Original package label", packageName: "example.game" };
  fs.writeFileSync(record, JSON.stringify(prior));
  t.mock.method(Reader, "identity", () => { throw new Error("Included reader missing"); });
  const bytes = fs.readFileSync(record), image = fs.readFileSync(icon);
  assert.equal(await Metadata.resolveGameIcon(entry, context), icon);
  const metadata = await Metadata.resolveGameMetadata(entry, context);
  assert.equal(metadata.name, prior.label);
  assert.equal(Metadata.mergeEntry(entry, { ...entry, ...metadata }).name, entry.name);
  await assert.rejects(Metadata.read(entry, { ...context, locale: "fr-FR" }), /Included reader missing/);
  fs.writeFileSync(apk, "changed package input");
  await assert.rejects(Metadata.read(entry, context), /Included reader missing/);
  assert.deepEqual(fs.readFileSync(record), bytes);
  assert.deepEqual(fs.readFileSync(icon), image);
});

test("Runtime.resolve preserves the complete declaration for launch verification", async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "android-metadata-verifier-"));
  const verifier = require("../src/modules/android/runtime-verifier");
  t.after(async () => { await verifier.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const digest = bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  const reader = path.join(temporary, "android-host.jar"), content = Buffer.from("fixture resource reader");
  fs.writeFileSync(reader, content, { mode: 0o644 }); fs.chmodSync(reader, 0o644);
  const member = { path: "android-host.jar", size: content.length, mode: 0o644, sha256: digest(content) };
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, version: "fixture", profile: { id: "fixture", javaMajor: 21,
    nativeLoadTarget: "maclauncher.android.bridge.GuestNativeLoader", packageMetadataVersion: 1 }, files: [member] }));
  fs.writeFileSync(path.join(temporary, "runtime.json"), manifest, { mode: 0o644 }); fs.chmodSync(path.join(temporary, "runtime.json"), 0o644);
  const declaration = { version: "fixture", minimumMacOS: "13.0", manifestSha256: digest(manifest),
    files: [member, { path: "runtime.json", size: manifest.length, mode: 0o644, sha256: digest(manifest) }] };
  const options = { root: temporary, platform: "darwin", arch: "arm64", macOSVersion: "13.0" };
  const selected = Runtime.resolve(options, declaration);
  assert.equal(selected.runtimeDeclaration, declaration);
  assert.equal(selected.runtimeIdentity.files, undefined, "Child identity remains compact");
  assert.equal((await Runtime.resolveForLaunch(options, selected.runtimeDeclaration)).version, "fixture");
  fs.writeFileSync(reader, Buffer.alloc(content.length, 33));
  await assert.rejects(Runtime.resolveForLaunch(options, selected.runtimeDeclaration), /checksum or permissions/,
    "The real worker verifies declared bytes instead of accepting only the small identity");
});

test("A decoder update preserves known artwork when unchanged package resources cannot be rendered", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "android-metadata-reader-update-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const apk = path.join(directory, "base.apk");
  fs.copyFileSync(path.join(__dirname, "fixtures/android-apk-metadata-standalone/base.apk"), apk);
  const entry = { gameId: "game", gamePath: apk }, context = { userDataDir: directory, locale: "en-US" };
  const cache = path.join(directory, "games/game/icons"); fs.mkdirSync(cache, { recursive: true });
  const icon = path.join(cache, "android.png"); fs.copyFileSync(path.resolve("src/modules/android/resources/icon.png"), icon);
  const prior = { identity: "earlier-verified-decoder", inputIdentity: require("node:crypto").createHash("sha256")
    .update(JSON.stringify([Metadata.sourceIdentity(entry), context.locale])).digest("hex"),
    icon: true, label: "Resolved package label", packageName: "org.maclauncher.metadata.fixture" };
  fs.writeFileSync(path.join(cache, "android.json"), JSON.stringify(prior));
  t.mock.method(Reader, "identity", () => "updated-native-decoder");
  t.mock.method(Reader, "inspect", async () => ({ label: prior.packageName, packageName: prior.packageName, iconFile: null, activityWindows: {} }));
  const bytes = fs.readFileSync(icon), result = await Metadata.read(entry, context);
  assert.equal(result.label, prior.label); assert.equal(result.iconPath, icon);
  assert.notEqual(result.identity, prior.identity);
  assert.deepEqual(fs.readFileSync(icon), bytes);
  const localized = await Metadata.read(entry, { ...context, locale: "fr-FR" });
  assert.equal(localized.label, prior.packageName, "An earlier locale cannot supply missing resources");
  assert.equal(localized.iconPath, null);
});

test("Android metadata replaces automatic titles while retaining edited titles", () => {
  const entry = { name: "org.example.game-1.2", gamePath: "/games/org.example.game-1.2.apk", moduleData: { packageName: "org.example.game" } };
  assert.equal(Metadata.mergeEntry(entry, { ...entry, name: "Example Game" }).name, "Example Game");
  assert.equal(Metadata.mergeEntry({ ...entry, name: "My favourite" }, { ...entry, name: "Example Game" }).name, "My favourite");
  assert.equal(Metadata.mergeEntry({ ...entry, name: "Example Game", moduleData: { resolvedLabel: "Example Game" } }, { ...entry, name: "Jeu Exemple" }).name, "Jeu Exemple");
});

test("APK icon lookup preserves provider artwork after a decoder failure and respects cancellation", async t => {
  const Custom = require("../src/modules/android/custom-main"), Providers = require("../src/modules/android/provider-main");
  const Android = require("../src/modules/android/main");
  t.mock.method(Custom, "resolveGameIcon", async () => { throw new Error("Unsupported package resources"); });
  let fallback = 0;
  t.mock.method(Providers, "resolveGameIcon", () => { fallback++; return "/provider/icon.png"; });
  assert.equal(await Android.resolveGameIcon({}, {}), "/provider/icon.png");
  const controller = new AbortController(); controller.abort(new Error("Cancelled import"));
  await assert.rejects(Android.resolveGameIcon({}, { signal: controller.signal }), /Cancelled import/);
  assert.equal(fallback, 1);
});

test("Original Android resource metadata renders adaptive icons, localizes labels and reuses disk results", async t => {
  if (process.platform !== "darwin") return t.skip("Requires the included macOS APK reader");
  try { Reader.resolve(); } catch { return t.skip("Requires the included APK reader payload"); }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "android-package-metadata-test-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const apk = path.join(temporary, "example.apk");
  fs.copyFileSync(path.join(__dirname, "fixtures/android-package-metadata/metadata.apk"), apk);
  const payload = { root: path.join(temporary, "absent-android-runtime"), version: "absent", profile: {} };
  const entry = { gameId: "example", gamePath: apk };
  const context = { userDataDir: temporary, payload, locale: "en-US" };
  for (const name of ["resolveSelected", "resolveForLaunch"]) t.mock.method(Runtime, name, () => assert.fail("Fresh metadata must not resolve a game runtime"));
  let children = 0; context.onToolProcessSpawn = () => { children++; };
  const cancellation = new AbortController();
  const cancelled = Metadata.read(entry, { ...context, signal: cancellation.signal });
  const shared = Metadata.read(entry, context);
  const beforeCancel = performance.now(); cancellation.abort(new Error("Cancelled metadata caller"));
  await assert.rejects(cancelled, /Cancelled metadata caller/);
  assert.ok(performance.now() - beforeCancel < 1000, "Cancellation must release only its caller");
  const first = await shared;
  assert.equal(first.label, "Metadata Game");
  assert.equal(first.packageName, "org.maclauncher.metadata.fixture");
  const png = fs.readFileSync(first.iconPath);
  assert.deepEqual([...png.subarray(0,8)], [137,80,78,71,13,10,26,10]);
  assert.equal(png.readUInt32BE(16), 256); assert.equal(png.readUInt32BE(20), 256);
  const before = fs.statSync(first.iconPath).mtimeMs;
  assert.equal((await Metadata.read(entry, context)).identity, first.identity);
  assert.equal(fs.statSync(first.iconPath).mtimeMs, before);
  const nativeUpdate = { ...context, payload: { root: path.join(temporary, "another-absent-runtime"), version: "different-native-runtime" } };
  assert.equal((await Metadata.read(entry, nativeUpdate)).identity, first.identity);
  assert.equal(fs.statSync(first.iconPath).mtimeMs, before);
  assert.equal(children, 1, "Concurrent callers share one reader; unchanged resources reuse the cache");
  const localized = await Metadata.read(entry, { ...context, locale: "fr-FR" });
  assert.equal(localized.label, "Jeu Métadonnées");
  assert.notEqual(localized.identity, first.identity);
  const splitDirectory = path.join(temporary, "split-input"); fs.mkdirSync(splitDirectory);
  for (const [input, output] of [["base.apk", "z-base.apk"], ["resources.apk", "a-resources.apk"]])
    fs.copyFileSync(path.join(__dirname, "fixtures/android-apk-metadata-standalone", input), path.join(splitDirectory, output));
  const split = await Metadata.read({ gameId: "split", gamePath: splitDirectory }, { ...context, locale: "fr-FR" });
  assert.equal(split.label, "Jeu Métadonnées", "Folder imports order the base by manifest identity and retain resource splits");
  assert.ok(split.iconPath);
  assert.deepEqual(split.activityWindows["org.maclauncher.metadata.fixture.LandscapeAlias"], { landscape: true });
  const config = { title: "example" }, cacheRoot = path.join(temporary, "cache"); fs.mkdirSync(cacheRoot);
  await Metadata.applyLaunchIdentity(config, { ...entry, name: "example" }, { sourceApk: apk, cacheRoot }, payload, context.java, context);
  assert.equal(config.title, "Metadata Game");
  assert.equal(path.dirname(config.iconFile), cacheRoot);
  assert.ok(Metadata.dockArguments(config).includes("-Xdock:icon=" + config.iconFile));
  const prepared = { sourceApk: apk, sourceName: "base.apk", cacheRoot,
    apkSha256: require("node:crypto").createHash("sha256").update(fs.readFileSync(apk)).digest("hex") };
  await Metadata.applyLaunchIdentity(config, { ...entry, name: "example" }, prepared, payload, context.java, context);
  const stored = JSON.parse(fs.readFileSync(path.join(temporary, "games/example/icons/android.json")));
  const relocated = { ...entry, gamePath: path.join(temporary, "original-moved.apk") };
  const cachedConfig = { title: "example" };
  await Metadata.applyLaunchIdentity(cachedConfig, relocated, { ...prepared, sourceApk: path.join(temporary, "retired-generation/base.apk") },
    payload, context.java, context);
  assert.equal(cachedConfig.title, "Metadata Game", "Verified unchanged APKs reuse metadata after original and preparation paths move");
  assert.equal(JSON.parse(fs.readFileSync(path.join(temporary, "games/example/icons/android.json"))).identity, stored.identity);
  const changedConfig = { title: "changed" };
  await Metadata.applyLaunchIdentity(changedConfig, relocated, { ...prepared,
    sourceApk: path.join(temporary, "absent-new-generation/base.apk"), apkSha256: "a".repeat(64) }, payload, context.java, context);
  assert.equal(changedConfig.title, "changed", "Changed APK contents require a new resource read instead of an earlier identity");
});

test("Original activity orientation selects the initial physical viewport without changing unconstrained windows", () => {
  const metadata = { activityWindows: { "game.Portrait": { landscape: false }, "game.Landscape": { landscape: true }, "game.Free": { landscape: null } } };
  for (const [activityClass, width, height, expected] of [
    ["game.Portrait", 1280, 800, [800, 1280]],
    ["game.Portrait", 617, 988, [617, 988]],
    ["game.Landscape", 800, 1280, [1280, 800]],
    ["game.Free", 800, 1280, [800, 1280]],
    ["game.Other", 800, 1280, [800, 1280]],
  ]) {
    const config = { activityClass, width, height };
    Metadata.applyActivityWindow(config, metadata);
    assert.deepEqual([config.width, config.height], expected);
    Metadata.applyActivityWindow(config, metadata);
    assert.deepEqual([config.width, config.height], expected, "the JVM's original policy remains idempotent");
  }
});

test("Original PackageParser activity policy reaches metadata before guest initialization", { timeout: 30000 }, async t => {
  const root = process.env.KLEPTON_NATIVE_RUNTIME, java = process.env.ANDROID_TEST_JAVA;
  if (process.platform !== "darwin" || !root || !java) return t.skip("Requires Android runtime and Java SDK");
  const { execFileSync } = require("node:child_process"), temp = fs.mkdtempSync(path.join(os.tmpdir(), "android-package-orientation-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const classes = path.join(temp, "classes"), data = path.join(temp, "data"), apk = path.resolve("tests/fixtures/android-package-metadata/metadata.apk");
  fs.mkdirSync(classes);fs.mkdirSync(data);
  const source = path.resolve("src/modules/android/native/java/maclauncher/android/framework"), cp = [classes, path.join(root, "android-host.jar"), path.join(root, "android-framework.jar")].join(path.delimiter);
  const javac = path.join(path.dirname(java), "javac"), fixture = path.resolve("tests/fixtures/android-package-metadata/PackageOrientationProbe.java");
  execFileSync(javac, ["--release", "21", "-cp", cp, "-d", classes, path.join(source, "HostActivity.java"), path.join(source, "PackageMetadata.java"), fixture], { timeout: 15000 });
  const identity = await require("../src/modules/android/process-channel").processNamespace(data, 1);
  const result = execFileSync(java, [...require("../src/modules/android/jvm-options").frameworkJvmOptions, "-Xverify:all", "-cp", cp, "maclauncher.android.PackageOrientationProbe", path.resolve(root), data, apk], { encoding: "utf8", timeout: 15000, env: { ...process.env, ...identity.environment } });
  assert.match(result, /PASS original parsed fixed orientation before application callbacks/);
});

test("Prepared service metadata follows the complete signed package set across conversion generations", () => {
  const base = { sourceApk: "/cache/generation1/base.apk", sourceName: "base.apk", apkSha256: "base-digest" };
  assert.deepEqual(Metadata.preparedSourceIdentity(base), Metadata.preparedSourceIdentity({ ...base, sourceApk: "/cache/generation2/base.apk" }));
  const split = { ...base, sources: [{ name: "base.apk", sha256: "base-digest" }, { name: "config.fr.apk", sha256: "fr-digest" }] };
  assert.notDeepEqual(Metadata.preparedSourceIdentity(base), Metadata.preparedSourceIdentity(split));
  assert.notDeepEqual(Metadata.preparedSourceIdentity(split), Metadata.preparedSourceIdentity({ ...split, sources: [...split.sources].reverse() }));
  assert.notDeepEqual(Metadata.preparedSourceIdentity(split), Metadata.preparedSourceIdentity({ ...split, sources: [split.sources[0], { name: "config.fr.apk", sha256: "updated-fr" }] }));
});
