// Store download helpers that follow their publishers: GOGdl from Heroic's
// GitHub releases and microG from its GmsCore releases.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { githubRoutes, githubRelease, withUnknownFields, mapRoutes } = require("../helpers/future-upstream.cjs");
const Gogdl = require("../../src/core/gogdl-tool");
const Microg = require("../../src/modules/android/google/packages");
const Play = require("../../src/modules/android/store/protocol");

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
// A release whose asset bytes match the size and digest GitHub publishes.
function release(repository, tag, files) {
  const value = githubRelease(repository, tag, Object.keys(files));
  value.assets = value.assets.map(asset => ({ ...asset, size: files[asset.name].length, digest: "sha256:" + sha256(files[asset.name]) }));
  return value;
}
function routes(repository, releases, files) {
  const result = githubRoutes(repository, releases);
  for (const value of releases) for (const asset of value.assets) result[asset.browser_download_url] = files[value.tag_name][asset.name];
  return result;
}
const temporary = t => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "future-upstream-store-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; };

const GOGDL = "Heroic-Games-Launcher/heroic-gogdl", arch = process.arch === "x64" ? "x64" : "arm64";
const gogdlFiles = (version, names = ["gogdl_macos_arm64", "gogdl_macos_x86_64", "gogdl_linux_x86_64", "gogdl_windows_x86_64.exe"]) =>
  Object.fromEntries(names.map(name => [name, Buffer.from(`${name} ${version}`)]));
function gogdlState(entries) {
  const files = Object.fromEntries(entries.map(([tag, names]) => [tag, gogdlFiles(tag, names)]));
  return routes(GOGDL, entries.map(([tag]) => release(GOGDL, tag, files[tag])), files);
}
async function gogdl(t, Harness, userDataDir, network) {
  Harness.network.routes = network;
  try { return await Gogdl.ensureGogdl({ userDataDir, arch, platform: "darwin" }); } finally { Harness.network.routes = null; }
}

const GMSCORE = "microg/GmsCore";
const microgFiles = (tag, code, extra = []) => Object.fromEntries([`com.google.android.gms-${code}034.apk`, `com.android.vending-${code % 100000000}.apk`,
  `com.google.android.gms-${code}034-hw.apk`, `com.android.vending-${code % 100000000}-hw.apk`, ...extra].map(name => [name, Buffer.from(`${name} ${tag}`)]));
function microgState(entries) {
  const files = Object.fromEntries(entries.map(([tag, code, names]) => [tag, names ? Object.fromEntries(names.map(name => [name, Buffer.from(`${name} ${tag}`)])) : microgFiles(tag, code)]));
  return routes(GMSCORE, entries.map(([tag]) => release(GMSCORE, tag, files[tag])), files);
}
// APK manifests and microG's signing certificate are checked by the real
// verifier in android-google tests; here the downloaded name stands for them.
const microgVerify = (file, pin) => {
  if (!fs.readFileSync(file, "utf8").startsWith(pin.filename)) throw new Error("The microG package identity differs from its release.");
  return { packageName: pin.packageName, versionCode: pin.versionCode, sha256: pin.sha256, signers: pin.signers };
};
async function microg(Harness, userDataDir, network) {
  Harness.network.routes = network;
  try {
    return await Microg.ensurePackages({ userDataDir }, { confirmToolInstall: async () => {}, withRuntimeMutation: (_identity, fn) => fn(), verifyPublishedApk: microgVerify });
  } finally { Harness.network.routes = null; }
}

// A Google Play delivery answer in its protobuf shape: base APK, splits and an
// expansion file, each with the size and hashes Google publishes.
function delivery({ splits, unknown = [] }) {
  const { field, message } = Play, hashes = name => [crypto.createHash("sha1").update(name).digest("base64url"), sha256(name)];
  const file = (name, [url, size, sha1, digest], extra = []) => message(field(url, `https://play.googleapis.com/download/by-token/download?token=${encodeURIComponent(name)}`),
    field(size, 4096), field(sha1, hashes(name)[0]), ...(digest ? [field(digest, hashes(name)[1])] : []), ...extra);
  const data = message(file("base", [3, 1, 2, 19]), field(5, message(field(1, "download"), field(2, "token"))),
    ...splits.map(name => field(15, message(field(1, name), file(name, [5, 2, 4, 9])))),
    field(4, message(field(1, 0), field(2, "42"), file("main", [4, 3, 8]))), ...unknown);
  return message(field(1, message(field(21, message(field(1, 1), field(2, data), ...unknown)))), ...unknown);
}

module.exports = {
  checks: {
    "Google Play deliveries with new splits and unknown fields install with the published hashes": async () => {
      const current = Play.parseDelivery(delivery({ splits: ["config.arm64_v8a", "config.xxhdpi"] }), "com.example.game", "42");
      assert.deepEqual(current.files.map(file => file.filename), ["base.apk", "split_config.arm64_v8a.apk", "split_config.xxhdpi.apk", "Android/obb/com.example.game/main.42.com.example.game.obb"]);
      const later = Play.parseDelivery(delivery({ splits: ["config.arm64_v8a", "feature:levels/v2", "config.ar-XB", "asset pack ✓"],
        unknown: [Play.field(77, "future"), Play.field(78, Play.message(Play.field(1, 5)))] }), "com.example.game", "42");
      assert.deepEqual(later.files.filter(file => file.type === "split").map(file => file.filename),
        ["split_config.arm64_v8a.apk", "split_feature_levels_v2.apk", "split_config.ar-XB.apk", "split_asset_pack__.apk"]);
      for (const file of later.files.filter(file => file.type !== "obb")) assert.match(file.sha256, /^[a-f0-9]{64}$/, `${file.filename} keeps its published hash`);
    },
    "microG follows its newest GmsCore release by name, digest and signer and keeps installations offline": async (t, Harness) => {
      const userDataDir = temporary(t), current = microgState([["v0.3.18.260332", 260332], ["v0.3.17.252432", 252432]]);
      const installed = await microg(Harness, userDataDir, current);
      assert.equal(installed.version, "0.3.18.260332");
      assert.deepEqual(installed.packages.map(pin => pin.filename), ["com.google.android.gms-260332034.apk", "com.android.vending-260332.apk"]);
      const list = current[`https://api.github.com/repos/${GMSCORE}/releases`];
      assert.equal(installed.packages[0].sha256, list[0].assets[0].digest.slice(7), "GitHub's published digest");
      assert.equal((await microg(Harness, userDataDir, {})).version, "0.3.18.260332", "an installation stays offline");
      assert.equal((await microg(Harness, temporary(t), mapRoutes(current, withUnknownFields))).version, "0.3.18.260332", "unknown release fields");
      assert.equal((await microg(Harness, temporary(t), microgState([["v0.3.19.270000", 270000], ["v0.3.18.260332", 260332]]))).version, "0.3.19.270000", "a new release");
      // Renamed builds, a release without the packages and a deleted newest release.
      const renamed = microgState([["v0.3.19.270000", 0, ["com.google.android.gms-270000034-universal.apk", "com.android.vending-84022700-universal.apk", "notes.txt"]],
        ["v0.3.18.260332", 260332]]);
      assert.equal((await microg(Harness, temporary(t), renamed)).packages[1].versionCode, 84022700);
      assert.equal((await microg(Harness, temporary(t), microgState([["v0.3.20.1", 0, ["GmsCore-0.3.20.1-sources.zip"]], ["v0.3.17.252432", 252432]]))).version, "0.3.17.252432");
      // A file replaced behind the same URL: the new digest verifies it; a stale one is rejected.
      const replaced = microgState([["v0.3.18.260332", 260332]]), url = Object.keys(replaced).find(key => key.endsWith("com.android.vending-260332.apk"));
      replaced[url] = Buffer.from("com.android.vending-260332.apk rebuilt");
      await assert.rejects(microg(Harness, temporary(t), replaced), /does not match the (?:size|checksum) its publisher lists/);
      replaced[`https://api.github.com/repos/${GMSCORE}/releases`][0].assets[1] = { ...replaced[`https://api.github.com/repos/${GMSCORE}/releases`][0].assets[1],
        size: replaced[url].length, digest: "sha256:" + sha256(replaced[url]) };
      assert.equal((await microg(Harness, temporary(t), replaced)).packages[1].sha256, sha256(replaced[url]));
    },
    "GOGdl follows new, renamed, replaced and removed releases and keeps working offline": async (t, Harness) => {
      const userDataDir = temporary(t), current = gogdlState([["v1.3.1"], ["v1.2.0"]]);
      const first = await gogdl(t, Harness, userDataDir, current);
      assert.equal(first.version, "1.3.1");
      assert.equal(fs.readFileSync(first.executablePath, "utf8"), `gogdl_macos_${arch === "x64" ? "x86_64" : "arm64"} v1.3.1`);
      assert.equal((await gogdl(t, Harness, temporary(t), mapRoutes(current, withUnknownFields))).version, "1.3.1", "unknown release fields");
      assert.equal((await gogdl(t, Harness, userDataDir, gogdlState([["v1.4.0"], ["v1.3.1"]]))).version, "1.4.0", "a new release");
      const renamed = await gogdl(t, Harness, temporary(t), gogdlState([["v2.0.0", ["gogdl-2.0.0-macos-universal", "gogdl-2.0.0-linux-x86_64"]], ["v1.3.1"]]));
      assert.equal(renamed.version, "2.0.0", "a renamed universal build");
      // The same release with a rebuilt file: GitHub's new digest verifies it.
      const replaced = gogdlState([["v1.4.0"], ["v1.3.1"]]), name = `gogdl_macos_${arch === "x64" ? "x86_64" : "arm64"}`, url = Object.keys(replaced).find(key => key.endsWith(`/v1.4.0/${name}`));
      replaced[url] = Buffer.from(`${name} v1.4.0 rebuilt`);
      const list = replaced[`https://api.github.com/repos/${GOGDL}/releases`];
      list[0].assets = list[0].assets.map(asset => asset.name === name ? { ...asset, size: replaced[url].length, digest: "sha256:" + sha256(replaced[url]) } : asset);
      const rebuilt = await gogdl(t, Harness, userDataDir, replaced);
      assert.equal(fs.readFileSync(rebuilt.executablePath, "utf8"), `${name} v1.4.0 rebuilt`);
      // Releases without a Mac build, or no answer at all, keep the installed helper.
      assert.equal((await gogdl(t, Harness, userDataDir, gogdlState([["v3.0.0", ["gogdl_linux_x86_64"]]]))).version, "1.4.0");
      assert.equal((await gogdl(t, Harness, userDataDir, {})).version, "1.4.0");
    }
  }
};
