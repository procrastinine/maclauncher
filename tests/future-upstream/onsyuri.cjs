const crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");

// ONScripter-Yuri publishes raw Mac executables named for their CPU next to a
// Web archive and other platforms' builds. The Mac and Web sections list
// separately; MacLauncher Builds packages answer 404 here.
const repository = "YuriSizuku/OnscripterYuri";
const assets = version => [`onsyuri_v${version}_aarch64_darwin`, `onsyuri_v${version}_x86-64_darwin`, `onsyuri_v${version}_web.7z`,
  `onsyuri_v${version}_x86-64_linux`, `onsyuri_v${version}_aarch64_linux`, `onsyuri_v${version}_x86-64_win.zip`, `onsyuri_v${version}_arm64-v8a_android.apk`];
const releases = ["0.7.6", "0.7.5"].map(version => githubRelease(repository, `v${version}`, assets(version)));
// Renamed: CPU words and archive formats change for both sections.
const rename = name => name.replace(/_aarch64_darwin$/, "_arm64_macos.tar.xz").replace(/_x86-64_darwin$/, "-macos-universal.zip").replace(/_web\.7z$/, "_web.tar.xz");
const scenarios = githubScenarios(repository, releases, { rename });
scenarios.renamedAsset.usable = true;
// Checksums and debug builds named like the Mac executable are never installed as it.
scenarios.addedAsset.routes = githubRoutes(repository, [githubRelease(repository, "v1.0.0", [...assets("1.0.0"),
  "onsyuri_v1.0.0_aarch64_darwin.sha256", "onsyuri_v1.0.0_aarch64_darwin_debug.zip", "onsyuri_v1.0.0_web_symbols.7z"]), ...releases]);

function archive(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "onsyuri-archive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "payload", "onsyuri-1.0.0-macos"), { recursive: true });
  fs.writeFileSync(path.join(root, "payload", "onsyuri-1.0.0-macos", "onsyuri"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "payload", "README.txt"), "Release notes\n");
  const file = path.join(root, "onsyuri.tar.xz");
  assert.equal(spawnSync("/usr/bin/tar", ["-cJf", file, "-C", path.join(root, "payload"), "."]).status, 0);
  return fs.readFileSync(file);
}

module.exports = { managers: ["onsyuri"], current: githubRoutes(repository, releases), scenarios,
  checks: {
    "ONScripter-Yuri installs a renamed Mac archive whose executable moved into a folder, verified by the published digest": async (t, Harness) => {
      const Manager = require("../../src/modules/shared/onsyuri/runtime/onsyuri-manager");
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "onsyuri-install-"));
      t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
      const bytes = archive(t), digest = crypto.createHash("sha256").update(bytes).digest("hex");
      const routes = scenarios.renamedAsset.routes, [release] = routes[`https://api.github.com/repos/${repository}/releases`];
      const asset = release.assets.find(item => item.name === "onsyuri_v1.0.0_arm64_macos.tar.xz");
      const publish = sha256 => ({ ...routes, [`https://api.github.com/repos/${repository}/releases`]: [{ ...release, assets: release.assets.map(item =>
        item === asset ? { ...item, size: bytes.length, digest: `sha256:${sha256}` } : item) }, ...routes[`https://api.github.com/repos/${repository}/releases`].slice(1)],
        [asset.browser_download_url]: bytes });
      // A file replaced behind the URL that does not match the listing is refused.
      Harness.network.routes = publish("f".repeat(64));
      await Manager.refreshCatalog({ userDataDir, force: true, sectionId: "mac", sourceId: "upstream" });
      await assert.rejects(Manager.installRuntime({ userDataDir, version: "1.0.0", variant: "arm64", sectionId: "mac" }), /checksum/);
      Harness.network.routes = publish(digest);
      await Manager.refreshCatalog({ userDataDir, force: true, sectionId: "mac", sourceId: "upstream" });
      await Manager.installRuntime({ userDataDir, version: "1.0.0", variant: "arm64", sectionId: "mac" });
      const installed = Manager.core.listInstalledMac(userDataDir).find(row => row.version === "1.0.0" && row.variant === "arm64");
      assert.equal(path.relative(installed.installDir, installed.executablePath), path.join("onsyuri-1.0.0-macos", "onsyuri"));
      assert.equal(fs.statSync(installed.executablePath).mode & 0o111, 0o111);
    }
  } };
