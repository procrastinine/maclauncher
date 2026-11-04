const { githubRoutes, githubRelease, githubScenarios } = require("../helpers/future-upstream.cjs");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");

// Anime4K publishes release archives; the other collections follow the newest
// commit of their default branch and list that commit's file tree.
const Catalog = require("../../src/modules/shared/reshade/managed-shader-packs.json");
const sha = text => crypto.createHash("sha1").update(text).digest("hex");
const extension = { mpv: ".glsl", isf: ".fs", magpie: ".hlsl", reshade: ".fx", libretro: ".slang" };
const API = "https://api.github.com/repos/";
function sourceFiles(pack) {
  if (!pack.sourceOverlay) return [];
  const recipe = pack.sourceOverlay.recipes[pack.sourceOverlay.version];
  return require(path.join("../../src/modules/shared/reshade", recipe)).sourceFiles;
}
// A commit's tree: its license notice, one shader in the first declared folder
// and every recipe input, unless `omit` names one of them.
function tree(pack, omit) {
  const folder = (pack.prefixes || []).find(prefix => prefix.endsWith("/")) || "";
  const files = [...new Set([pack.licenseFile, `${folder}example${extension[pack.family]}`, ...sourceFiles(pack)])].filter(file => file !== omit);
  return { sha: sha(pack.id + "tree"), truncated: false,
    tree: files.map(file => ({ path: file, mode: "100644", type: "blob", sha: sha(file), size: 64 })) };
}
function commitRoutes(heads = {}) {
  const routes = {};
  for (const pack of Catalog.packs.filter(pack => pack.delivery !== "release-zip")) {
    const head = heads[pack.id] || { sha: sha(pack.id) };
    routes[`${API}${pack.repository}/commits`] = [{ sha: head.sha, html_url: `https://github.com/${pack.repository}/commit/${head.sha}`,
      commit: { committer: { date: "2026-01-01T00:00:00Z" } } }];
    routes[`${API}${pack.repository}/git/trees/${head.sha}`] = tree(pack, head.omit);
  }
  return routes;
}
const anime4k = "bloc97/Anime4K";
const releases = [["v4.0.1", "Anime4K_v4.0.zip"], ["v3.1", "Anime4K_v3.1.zip"]].map(([tag, name]) => githubRelease(anime4k, tag, [name]));
const scenarios = githubScenarios(anime4k, releases);
// A release that ships its shaders in another archive format the library
// extracts is installable.
scenarios.renamedAsset.usable = true;
for (const scenario of Object.values(scenarios)) if (scenario) scenario.routes = { ...scenario.routes, ...commitRoutes() };
const manager = () => require("../../src/modules/shared/reshade/runtime/shader-library-manager");
const section = (userDataDir, id) => manager().getState({ userDataDir }).sections.find(row => row.id === id).catalog;
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "future-shaders-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}

module.exports = {
  managers: ["graphics-shader-library"],
  current: { ...githubRoutes(anime4k, releases), ...commitRoutes() },
  scenarios,
  savedDefault: false,
  checks: {
    "Shader collections list each new commit beside earlier ones and skip a commit without its declared files with a reason": async (t, Harness) => {
      const userDataDir = temporary(t), artcnn = Catalog.packs.find(pack => pack.id === "artcnn"), ssrt3 = Catalog.packs.find(pack => pack.id === "ssrt3");
      const version = (pack, commit) => section(userDataDir, pack.id).versions.find(value => value.includes(commit));
      Harness.network.routes = { ...githubRoutes(anime4k, releases), ...commitRoutes() };
      await manager().refreshCatalog({ userDataDir, force: true });
      const first = version(artcnn, sha("artcnn"));
      Harness.network.routes = { ...githubRoutes(anime4k, releases), ...commitRoutes({ artcnn: { sha: sha("artcnn next") } }) };
      await manager().refreshCatalog({ userDataDir, force: true });
      const next = version(artcnn, sha("artcnn next"));
      assert.ok(first && next && section(userDataDir, "artcnn").installableVersions.includes(first));
      Harness.network.routes = { ...githubRoutes(anime4k, releases), ...commitRoutes({
        ssrt3: { sha: sha("ssrt3 without input"), omit: sourceFiles(ssrt3)[0] } }) };
      await manager().refreshCatalog({ userDataDir, force: true });
      for (const [pack, commit, missing] of [[ssrt3, "ssrt3 without input", sourceFiles(ssrt3)[0]]]) {
        const catalog = section(userDataDir, pack.id), skipped = version(pack, sha(commit));
        assert.ok(catalog.versions.includes(skipped), `${pack.id}: the new commit stays listed`);
        assert.equal(catalog.versionRequirements[skipped].installReason, `This revision does not contain ${missing}.`);
        assert.ok(!catalog.installableVersions.includes(skipped) && catalog.latestAvailableVersion !== skipped);
      }
      assert.deepEqual(section(userDataDir, "artcnn").installableVersions.sort(), [first, next].sort());
    },
    "Shader collections follow the default branch head and a replaced release archive's new digest": async (t, Harness) => {
      const userDataDir = temporary(t);
      const replaced = [{ ...releases[0], assets: releases[0].assets.map(asset => ({ ...asset, size: asset.size + 1, digest: "sha256:" + "e".repeat(64) })) }, releases[1]];
      Harness.network.routes = { ...githubRoutes(anime4k, replaced), ...commitRoutes({ cunny: { sha: sha("cunny renamed branch") } }) };
      await manager().refreshCatalog({ userDataDir, force: true }).catch(() => {});
      assert.ok(section(userDataDir, "cunny").versions.some(value => value.includes(sha("cunny renamed branch"))));
      const row = manager().core.available(userDataDir, "anime4k").find(entry => entry.version === "4.0.1");
      assert.equal(row.archive.sha256, "e".repeat(64));
    }
  }
};
