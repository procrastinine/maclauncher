// Adoptium's API lists Temurin releases of one Java line, one query per CPU.
const crypto = require("node:crypto");
const API = "https://api.adoptium.net/v3/assets/feature_releases/21/ga";
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
const release = (version, { name = (arch, file) => `OpenJDK21U-jdk_${arch}_mac_hotspot_${file}.tar.gz`, extra = [] } = {}) => arch => {
  const [semver, build] = version.split("+"), file = `${semver}_${build}`;
  return { release_name: `jdk-${version}`, release_type: "ga", vendor: "eclipse", timestamp: "2026-07-15T00:00:00Z", updated_at: "2026-07-15T00:00:00Z",
    version_data: { major: 21, minor: 0, security: Number(semver.split(".")[2]), build: Number(build), openjdk_version: `${version}-LTS`, semver: `${version}.0.LTS` },
    binaries: [...extra, { architecture: arch, os: "mac", image_type: "jdk", jvm_impl: "hotspot", heap_size: "normal", project: "jdk",
      package: { name: name(arch, file), link: `https://github.com/adoptium/temurin21-binaries/releases/download/jdk-${encodeURIComponent(version)}/${name(arch, file)}`,
        checksum: sha(name(arch, file)), size: 200000000 } }] };
};
// The query names the CPU; the route answers with that CPU's builds.
const routes = releases => ({ [API]: url => {
  const query = new URL(url).searchParams;
  return query.get("page") === "0" ? releases.map(item => item(query.get("architecture"))) : [];
} });
const current = [release("21.0.8+9"), release("21.0.7+6")];
module.exports = { managers: ["java"], current: routes(current), scenarios: {
  newVersion: { routes: routes([release("21.0.9+1"), ...current]), version: "21.0.9+1", usable: true },
  // Another package name and archive format, next to a debug image and an SBOM.
  renamedAsset: { routes: routes([release("21.0.9+10", { name: (arch, file) => `OpenJDK21U-jdk_${arch}_macos_hotspot_${file}.zip`,
    extra: [{ architecture: "aarch64", os: "mac", image_type: "debugimage", package: { name: "debug.tar.gz", link: "https://example.invalid/debug.tar.gz" } },
      { architecture: "x64", os: "mac", image_type: "sbom", package: { name: "sbom.json", link: "https://example.invalid/sbom.json" } }] }), ...current]),
    version: "21.0.9+10", usable: true },
  // A release whose metadata cannot be read leaves the others listed.
  unreadableRelease: { routes: routes([() => ({ release_name: "jdk-21.0.9+1", binaries: [{ os: "mac", image_type: "jdk", package: { link: "not a url" } }] }), ...current]),
    version: "21.0.8+9", usable: true },
  deletedRelease: { routes: routes(current.slice(0, 1)), version: "21.0.8+9", usable: true, deleted: "21.0.7+6" }
},
checks: {
  "Java verifies the SHA-256 Adoptium publishes for a package": async t => {
    const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    const { network } = require("../helpers/future-upstream.cjs"), JavaCore = require("../../src/modules/java/runtime/java-runtime");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "java-checksum-")); t.after(() => { network.routes = null; fs.rmSync(root, { recursive: true, force: true }); });
    // The file behind the link changed after the API answered.
    network.routes = { "https://example.invalid/OpenJDK.tar.gz": "replaced package" };
    const asset = { version: "21.0.9+10", url: "https://example.invalid/OpenJDK.tar.gz", fileName: "OpenJDK.tar.gz", checksum: sha("published package") };
    await assert.rejects(JavaCore.installVersion({ userDataDir: root, line: 21, version: asset.version, variant: "arm64", hostArch: "arm64",
      lineCatalog: { versions: [asset.version], entriesByVersion: { [asset.version]: { arm64: asset, x64: null } } } }), /checksum its publisher lists/);
  },
  "Java lists every non-LTS feature release in Other, a future one included": async t => {
    const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    const { network } = require("../helpers/future-upstream.cjs"), Manager = require("../../src/modules/java/runtime/java-runtime-manager");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "java-other-")); t.after(() => { network.routes = null; fs.rmSync(root, { recursive: true, force: true }); });
    const line = (major, version) => ({ [`https://api.adoptium.net/v3/assets/feature_releases/${major}/ga`]: url => new URL(url).searchParams.get("page") === "0"
      ? [JSON.parse(JSON.stringify(release(version)(new URL(url).searchParams.get("architecture"))).replaceAll("temurin21", `temurin${major}`))] : [] });
    network.routes = { "https://api.adoptium.net/v3/info/available_releases": { available_lts_releases: [8, 11, 17, 21, 25], available_releases: [8, 11, 17, 21, 24, 25, 26],
      most_recent_feature_release: 26, most_recent_lts: 25 }, ...line(24, "24.0.2+12"), ...line(26, "26.0.1+3") };
    await Manager.refreshCatalog({ userDataDir: root, sectionId: "other", force: true });
    const other = Manager.getState({ userDataDir: root, settings: {} }).sections.find(section => section.id === "other");
    assert.deepEqual(other.catalog.versions, ["26.0.1+3", "24.0.2+12"]);
    assert.equal(Manager.lineState({ userDataDir: root, settings: {}, line: 26 }).defaultVersion, "26.0.1+3");
  }
} };
