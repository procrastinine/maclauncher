const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const Manager = require("../src/modules/love/runtime/love-runtime-manager");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents, options) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, options);
}

function createInstall(
  userDataDir,
  channel,
  version,
  { bundleVersion = version, headSha = "abcdef0", runStartedAt = "2026-03-01T15:25:27Z" } = {}
) {
  const installDir = path.join(userDataDir, "runtimes", "love", channel, version);
  const appPath = path.join(installDir, "love.app");
  writeFile(path.join(appPath, "Contents", "MacOS", "love"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755
  });
  writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\"",
      "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist version=\"1.0\">",
      "<dict>",
      "  <key>CFBundleExecutable</key>",
      "  <string>love</string>",
      "  <key>CFBundleShortVersionString</key>",
      `  <string>${bundleVersion}</string>`,
      "</dict>",
      "</plist>",
      ""
    ].join("\n")
  );
  writeFile(
    path.join(installDir, ".maclauncher-love.json"),
    JSON.stringify(
      {
        channel,
        version,
        buildKey: channel === "nightly" ? version : null,
        bundleVersionRaw: bundleVersion,
        bundleVersionNormalized: bundleVersion,
        headSha,
        runStartedAt
      },
      null,
      2
    )
  );
  return installDir;
}

test("LÖVE preserves explicit global game choices", () => {
  const settings = Manager.normalizeSettings({
    stable: { defaultVersion: " 11.5 " },
    nightly: { defaultVersion: " 2026-03-01T15-25-27Z_abc " }
  });
  assert.equal(settings.stable.defaultVersion, "11.5");
  assert.equal(settings.nightly.defaultVersion, "2026-03-01T15-25-27Z_abc");
});

test("setDefault records the exact LÖVE release or nightly choice", () => {
  const stable = Manager.applySettingsUpdate("setDefault", {
    sectionId: "stable",
    version: "0.10.2"
  }, {});
  assert.equal(stable.stable.defaultVersion, "0.10.2");

  const nightly = Manager.applySettingsUpdate("setDefault", {
    sectionId: "nightly",
    version: "2026-03-01T15-25-27Z_deadbeef"
  }, {});
  assert.equal(nightly.nightly.defaultVersion, "2026-03-01T15-25-27Z_deadbeef");
});

test("core picks the preferred macOS asset from a stable release", () => {
  const asset = Manager.core.__test.pickStableReleaseAsset({
    assets: [
      { name: "love-11.5-apple-libraries.zip" },
      { name: "love-11.5-macosx-x64.zip" },
      { name: "love-11.5-macos.zip" }
    ]
  });
  assert.equal(asset.name, "love-11.5-macos.zip");
});

test("core lists GitHub Actions nightlies through the shared HTTP transport", async () => {
  const request = async value => {
    const url = new URL(value);
    let body;
    if (url.pathname.includes("/actions/workflows/")) body = { workflow_runs: [{ id: 42, head_branch: "main", conclusion: "success",
      head_sha: "7d41f3ad30f4a171140f8b2ff53e534add018bb4", run_started_at: "2026-03-01T15:25:27Z" }] };
    else if (url.pathname.includes("/actions/runs/42/artifacts")) body = { artifacts: [{ id: 77, name: "love-macos", expired: false }] };
    else if (url.pathname.endsWith("/contents/src/common/version.h")) body = { content: Buffer.from('#define LOVE_VERSION_STRING "12.0"\n').toString("base64") };
    else assert.fail(`Unexpected HTTP request: ${value}`);
    return { status: 200, body: Buffer.from(JSON.stringify(body)), headers: {} };
  };
  const result = await Manager.core.listNightlyBuilds({ latestOnly: true, request });
  assert.deepEqual(result.versions, ["2026-03-01T15-25-27Z_7d41f3ad30f4a171140f8b2ff53e534add018bb4"]);
  assert.equal(result.entries[0].artifactId, 77);
  assert.equal(result.entries[0].headSha, "7d41f3ad30f4a171140f8b2ff53e534add018bb4");
  assert.equal(result.entries[0].sourceVersion, "12.0");
  assert.match(result.entries[0].label, /12\.0.*7d41f3a/);
  assert.doesNotMatch(result.entries[0].label, /main/);
});

test("refreshCatalog loads the full stable catalog by default", async () => {
  const originalFetch = Manager.core.fetchAvailableVersions;
  try {
    const calls = [];
    Manager.__test.resetState();
    Manager.core.fetchAvailableVersions = async payload => {
      calls.push(payload || {});
      return {
        versions: ["11.5", "11.4", "11.3"],
        entriesByVersion: {},
        source: "test"
      };
    };

    await Manager.refreshCatalog({ force: true, sectionId: "stable" });
    assert.equal(calls.length, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(calls[0], "latestOnly"));
  } finally {
    Manager.core.fetchAvailableVersions = originalFetch;
    Manager.__test.resetState();
  }
});

test("getState exposes Releases and Nightlies sections with nightly labels", () => {
  const userDataDir = makeTempDir("maclauncher-love-manager-");
  try {
    Manager.__test.resetState();
    createInstall(userDataDir, "stable", "11.5");
    const buildKey = "2026-03-01T15-25-27Z_7d41f3ad30f4a171140f8b2ff53e534add018bb4";
    createInstall(userDataDir, "nightly", buildKey, {
      bundleVersion: "12.0",
      headSha: "7d41f3ad30f4a171140f8b2ff53e534add018bb4",
      runStartedAt: "2026-03-01T15:25:27Z"
    });

    const state = Manager.getState({
      settings: {
        stable: { defaultVersion: "11.5" },
        nightly: { defaultVersion: buildKey }
      },
      userDataDir
    });

    assert.ok(Array.isArray(state.sections));
    assert.equal(state.sections[0].id, "stable");
    assert.equal(state.sections[0].label, "LÖVE 11");
    assert.equal(state.sections[0].catalog.supportsLatestOnly, false);
    assert.equal(state.sections[1].id, "nightly");
    assert.equal(state.sections[1].label, "LÖVE 12 nightly");
    assert.equal(state.sections[1].catalog.supportsLatestOnly, true);
    assert.equal(state.sections[0].supportsDefault, true);
    assert.equal(state.sections[1].supportsDefault, true);
    assert.equal(state.sections[2].supportsDefault, true);
    assert.match(String(state.sections[1].versionLabels[buildKey] || ""), /12\.0/);
  } finally {
    Manager.__test.resetState();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("LÖVE first installs save section defaults and uninstall preserves choices", () => {
  const userDataDir = makeTempDir("maclauncher-love-manager-");
  try {
    const buildKey = "2026-03-01T15-25-27Z_7d41f3ad30f4a171140f8b2ff53e534add018bb4";
    createInstall(userDataDir, "stable", "11.5");
    createInstall(userDataDir, "nightly", buildKey, { bundleVersion: "12.0" });

    const afterStableInstall = Manager.updateSettingsAfterInstall({}, {
      channel: "stable",
      version: "11.5"
    }, {
      sectionId: "stable"
    });
    assert.equal(afterStableInstall.stable.defaultVersion, "11.5");

    const afterNightlyInstall = Manager.updateSettingsAfterInstall(afterStableInstall, {
      channel: "nightly",
      version: buildKey,
      buildKey
    }, {
      sectionId: "nightly"
    });
    assert.equal(afterNightlyInstall.stable.defaultVersion, "11.5");
    assert.equal(afterNightlyInstall.nightly.defaultVersion, buildKey);

    const afterNightlyUninstall = Manager.updateSettingsAfterUninstall(
      afterNightlyInstall,
      { sectionId: "nightly" },
      { userDataDir }
    );
    assert.deepEqual(afterNightlyUninstall, afterNightlyInstall);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("LÖVE installs preserve framework aliases after the extraction directory is removed", t => {
  const extracted = makeTempDir("maclauncher-love-extracted-");
  const userDataDir = makeTempDir("maclauncher-love-installed-");
  t.after(() => fs.rmSync(extracted, { recursive: true, force: true }));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const originalInstall = createInstall(extracted, "stable", "11.5");
  const source = path.join(originalInstall, "love.app");
  const framework = path.join(source, "Contents", "Frameworks", "freetype.framework");
  writeFile(path.join(framework, "Versions", "A", "freetype"), "framework bytes", { mode: 0o755 });
  writeFile(path.join(framework, "Versions", "A", "Resources", "Info.plist"), "resources");
  fs.symlinkSync("A", path.join(framework, "Versions", "Current"));
  fs.symlinkSync("Versions/Current/freetype", path.join(framework, "freetype"));
  fs.symlinkSync("Versions/Current/Resources", path.join(framework, "Resources"));
  const destination = path.join(userDataDir, "runtimes", "love", "stable", "11.5", "love.app");
  Manager.core.__test.copyAppBundle(source, destination);
  assert.equal(fs.readlinkSync(path.join(framework, "Versions", "Current")), "A");
  fs.rmSync(extracted, { recursive: true, force: true });
  const installed = Manager.core.resolveInstalled({ userDataDir, channel: "stable", version: "11.5" });
  assert.equal(installed.ready, true);
  assert.equal(fs.readFileSync(path.join(destination, "Contents", "Frameworks", "freetype.framework", "freetype"), "utf8"), "framework bytes");
});

test("damaged stable and nightly LÖVE bundles cannot satisfy runtime selection", t => {
  const userDataDir = makeTempDir("maclauncher-love-damaged-");
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  createInstall(userDataDir, "stable", "11.4");
  const stable = createInstall(userDataDir, "stable", "11.5");
  const buildKey = "2026-03-01T15-25-27Z_deadbeef";
  const nightly = createInstall(userDataDir, "nightly", buildKey, { bundleVersion: "12.0" });
  for (const install of [stable, nightly]) {
    const versions = path.join(install, "love.app", "Contents", "Frameworks", "freetype.framework", "Versions");
    fs.mkdirSync(versions, { recursive: true });
    fs.symlinkSync(path.join(userDataDir, "deleted-extraction", "A"), path.join(versions, "Current"));
  }
  assert.equal(Manager.core.listInstalledStable(userDataDir).find(entry => entry.version === "11.5").ready, false);
  assert.equal(Manager.core.listInstalledNightly(userDataDir)[0].ready, false);
  assert.equal(Manager.core.resolveInstalled({ userDataDir, channel: "stable", version: "11.5" }), null);
  assert.equal(Manager.core.resolveInstalled({ userDataDir, channel: "nightly", version: buildKey }), null);
  assert.equal(Manager.core.findNightlyByBundleVersion({ userDataDir, version: "12.0" }), null);
  assert.equal(Manager.core.resolveInstalled({userDataDir, channel:"stable", version:"11.4"}).version, "11.4");
  assert.equal(Manager.core.resolveInstalled({userDataDir, channel:"nightly", version:"not-a-build"}), null);
  const state = Manager.getState({ userDataDir, settings: {} });
  assert.deepEqual(state.sections.slice(0, 2).map(section => section.installed.filter(row => row.ready !== false).map(row => row.version)), [["11.4"], []]);
});
