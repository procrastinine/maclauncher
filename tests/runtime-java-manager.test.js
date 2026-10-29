const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const { spawnSync } = require("node:child_process");

const Manager = require("../src/modules/java/runtime/java-runtime-manager");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createJavaInstall(userDataDir, { line, version, variant }) {
  const installDir = path.join(
    userDataDir,
    "runtimes",
    "java",
    String(line),
    version,
    variant
  );
  const javaPath = path.join(installDir, "bin", "java");
  fs.mkdirSync(path.dirname(javaPath), { recursive: true });
  fs.writeFileSync(javaPath, "");
  return installDir;
}

function createVineflowerInstall(userDataDir, version) {
  const installDir = path.join(userDataDir, "runtimes", "vineflower", version);
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, "vineflower.jar"), "");
  return installDir;
}

test("Java archive installation preserves relative aliases after its temporary extraction is deleted", async t => {
  const root = makeTempDir("maclauncher-java-copy-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageDir = path.join(root, "package");
  const javaHome = path.join(packageDir, "Fixture.jdk", "Contents", "Home");
  fs.mkdirSync(path.join(javaHome, "bin"), { recursive: true });
  fs.mkdirSync(path.join(javaHome, "lib"), { recursive: true });
  fs.writeFileSync(path.join(javaHome, "bin", "java"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(javaHome, "lib", "libdemo.1.dylib"), "runtime dependency");
  fs.symlinkSync("libdemo.1.dylib", path.join(javaHome, "lib", "libdemo.dylib"));
  const archivePath = path.join(root, "java.tar.gz");
  const tar = spawnSync("/usr/bin/tar", ["-czf", archivePath, "-C", packageDir, "Fixture.jdk"], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  const archive = fs.readFileSync(archivePath);
  t.mock.method(https, "get", (url, _options, callback) => {
    assert.equal(url, "https://example.invalid/java.tar.gz");
    const response = Readable.from([archive]);
    response.statusCode = 200;
    response.headers = { "content-length": String(archive.length) };
    const request = new EventEmitter();
    request.destroy = error => response.destroy(error);
    response.once("close", () => request.emit("close"));
    process.nextTick(() => callback(response));
    return request;
  });
  const temporaryExtractions = [];
  const mkdtemp = fs.mkdtempSync;
  t.mock.method(fs, "mkdtempSync", (...args) => {
    const created = mkdtemp(...args);
    if (path.basename(args[0]).startsWith("maclauncher-java-")) temporaryExtractions.push(created);
    return created;
  });
  const version = "17.0.12+7";
  const variant = process.arch === "arm64" ? "arm64" : "x64";
  const installed = await Manager.core.java.installVersion({
    userDataDir: path.join(root, "profile"), line: 17, version, variant,
    lineCatalog: { versions: [version], entriesByVersion: { [version]: {
      [variant]: { version, url: "https://example.invalid/java.tar.gz", fileName: "java.tar.gz" }
    } } }
  });
  assert.equal(temporaryExtractions.length, 1);
  assert.equal(fs.existsSync(temporaryExtractions[0]), false);
  assert.equal(fs.readlinkSync(path.join(javaHome, "lib", "libdemo.dylib")), "libdemo.1.dylib");
  fs.rmSync(packageDir, { recursive: true, force: true });
  const copiedLink = path.join(installed.installDir, "lib", "libdemo.dylib");
  assert.equal(fs.readlinkSync(copiedLink), "libdemo.1.dylib");
  assert.equal(fs.readFileSync(copiedLink, "utf8"), "runtime dependency");
});

test("Java preserves explicit game choices and retains the decompiler tool choice", () => {
  const normalized = Manager.normalizeSettings({
    defaultLine: "17",
    lines: {
      17: { defaultVersion: "17.0.12+1", defaultVariant: "arm64" }
    },
    vineflower: { defaultVersion: "1.11.0" }
  });

  assert.equal(normalized.defaultLine, 17);
  assert.equal(normalized.lines[17].defaultVersion, "17.0.12+1");
  assert.equal(normalized.lines[17].defaultVariant, Manager.core.java.defaultVariantForHost());
  assert.equal(normalized.vineflower.defaultVersion, "1.11.0");

  const fallback = Manager.normalizeSettings({});
  assert.equal(fallback.defaultLine, null);
  assert.ok(fallback.lines[21]);
});

test("java runtime manager exposes line and vineflower sections", () => {
  const userDataDir = makeTempDir("maclauncher-java-runtime-");
  try {
    const state = Manager.getState({ settings: {}, userDataDir });
    assert.ok(Array.isArray(state.sections));
    assert.deepEqual(
      state.sections.map(section => section.id),
      ["8", "11", "17", "21", "25", "vineflower"]
    );
    assert.equal(state.sections[0].catalog.status, "idle");
    assert.equal(state.sections[5].catalog.status, "idle");
    assert.ok(state.sections.every(section => section.catalog.supportsLatestOnly === false));
    assert.ok(Array.isArray(state.sections[0].variants));
    assert.ok(state.sections.slice(0, 5).every(section => section.supportsDefault === true));
    assert.equal(state.sections[5].supportsDefault, true);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("setDefault preserves exact user choices for Java and Vineflower", () => {
  const line = Manager.applySettingsUpdate(
    "setDefault",
    { sectionId: "21", version: "21.0.4+7", variant: "arm64" },
    {}
  );
  assert.equal(line.lines[21].defaultVersion, "21.0.4+7");

  const vineflower = Manager.applySettingsUpdate(
    "setDefault",
    { sectionId: "vineflower", version: "1.11.0" },
    {}
  );
  assert.equal(vineflower.vineflower.defaultVersion, "1.11.0");
});

test("Java uninstall leaves existing game settings untouched", () => {
  const userDataDir = makeTempDir("maclauncher-java-runtime-");
  try {
    createJavaInstall(userDataDir, {
      line: 21,
      version: "21.0.2+13",
      variant: "x64"
    });
    createJavaInstall(userDataDir, {
      line: 21,
      version: "21.0.4+7",
      variant: "arm64"
    });

    const next = Manager.updateSettingsAfterUninstall(
      {
        defaultLine: 21,
        lines: {
          21: { defaultVersion: "21.0.6+1", defaultVariant: "x64" }
        }
      },
      { sectionId: "21" },
      { userDataDir }
    );

    assert.equal(next.lines[21].defaultVersion, "21.0.6+1");
    assert.equal(next.lines[21].defaultVariant, "x64");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("updateSettingsAfterUninstall restores the committed Vineflower installed fallback", () => {
  const userDataDir = makeTempDir("maclauncher-java-runtime-");
  try {
    createVineflowerInstall(userDataDir, "1.10.0");
    createVineflowerInstall(userDataDir, "1.11.0");

    const next = Manager.updateSettingsAfterUninstall(
      {
        vineflower: { defaultVersion: "1.12.0" }
      },
      { sectionId: "vineflower" },
      { userDataDir }
    );

    assert.equal(next.vineflower.defaultVersion, "1.11.0");
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("java core host variant selection supports Rosetta fallback", () => {
  const choose = Manager.core.java.__test.chooseVariantForHost;

  const native = choose({
    availableVariants: new Set(["arm64", "x64"]),
    preferredVariant: null,
    hostArch: "arm64"
  });
  assert.equal(native.variant, "arm64");
  assert.equal(native.requiresRosetta, false);

  const rosetta = choose({
    availableVariants: new Set(["x64"]),
    preferredVariant: null,
    hostArch: "arm64"
  });
  assert.equal(rosetta.variant, "x64");
  assert.equal(rosetta.requiresRosetta, true);
});

test("Java installation leaves existing game settings untouched", () => {
  const next = Manager.updateSettingsAfterInstall(
    {
      defaultLine: 21,
      lines: {
        21: { defaultVersion: "21.0.10+7", defaultVariant: "arm64" }
      }
    },
    {
      line: 21,
      version: "21.0.9+10",
      variant: "x64"
    },
    { sectionId: "21" }
  );

  assert.equal(next.defaultLine, 21);
  assert.equal(next.lines[21].defaultVersion, "21.0.10+7");
  assert.equal(next.lines[21].defaultVariant, "arm64");
});

test("java line variant resolution collapses to x64 when arm64 is unavailable", () => {
  const variantSet = Manager.__test.collectLineVariantSet(
    {
      entriesByVersion: {
        "8.0.482+8": {
          arm64: null,
          x64: { url: "https://example.invalid/java8-x64.tar.gz" }
        }
      }
    },
    []
  );
  assert.deepEqual(Array.from(variantSet).sort(), ["x64"]);

  const defaultVariant = Manager.__test.resolveDefaultVariantForLine(
    variantSet,
    "arm64"
  );
  assert.equal(defaultVariant, "x64");
});

test("java catalog treats 404/204 as empty variant responses", () => {
  const isEmpty = Manager.core.java.__test.isEmptyCatalogStatus;
  assert.equal(isEmpty(404), true);
  assert.equal(isEmpty(204), true);
  assert.equal(isEmpty(200), false);
  assert.equal(isEmpty(500), false);
});

function catalogRelease(patch, architecture = "x64") {
  return {
    version_data: { semver: `21.0.${patch}+7` },
    timestamp: "2026-09-01T00:00:00Z",
    binaries: [{
      architecture, os: "mac", image_type: "jdk",
      package: { name: "jdk.tar.gz", link: `https://example.invalid/${architecture}/${patch}.tar.gz` }
    }]
  };
}

test("Java ordinary catalog paginates a hundred releases for each Mac architecture", async () => {
  const calls = [];
  const fetcher = async raw => {
    const url = new URL(raw);
    calls.push(url);
    const architecture = url.searchParams.get("architecture");
    assert.equal(url.searchParams.get("page_size"), "20");
    const page = Number(url.searchParams.get("page"));
    const data = Array.from({ length: 20 }, (_, index) => catalogRelease(100 - page * 20 - index, architecture));
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(data)) };
  };
  const all = await Manager.core.java.fetchAvailableVersionsForLine({ line: 21, fetcher });
  assert.equal(calls.length, 10);
  assert.equal(all.versions.length, 100);
  assert.equal(all.versions[0], "21.0.100+7");
  assert.equal(all.versions.at(-1), "21.0.1+7");
  assert.ok(all.entriesByVersion["21.0.1+7"].arm64);
  assert.ok(all.entriesByVersion["21.0.1+7"].x64);
});

test("Java empty final page retains earlier releases and explicit latest limits requests", async () => {
  const calls = [];
  const fetcher = async raw => {
    const url = new URL(raw);
    calls.push(url);
    if (url.searchParams.get("page") === "1") return { status: 204, headers: {}, body: Buffer.alloc(0) };
    const architecture = url.searchParams.get("architecture");
    const count = Number(url.searchParams.get("page_size"));
    const data = Array.from({ length: count }, (_, index) => catalogRelease(100 - index, architecture));
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(data)) };
  };
  const all = await Manager.core.java.fetchAvailableVersionsForLine({ line: 21, fetcher });
  assert.equal(all.versions.length, 20);
  assert.equal(calls.length, 4);
  calls.length = 0;
  const latest = await Manager.core.java.fetchAvailableVersionsForLine({ line: 21, latestOnly: true, fetcher });
  assert.deepEqual(latest.versions, ["21.0.100+7"]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.searchParams.get("page_size") === "1"));
});

test("Java extracts the matching Mac JDK from releases with multiple binaries", () => {
  const release = catalogRelease(9, "aarch64");
  release.binaries.unshift({ architecture: "x64", os: "windows", image_type: "jdk" });
  assert.equal(Manager.core.java.__test.extractAssetFromRelease(release, 21, "arm64").variant, "arm64");
});

test("Java pager respects Adoptium's maximum page size and rejects malformed metadata", async () => {
  await assert.rejects(Manager.core.java.__test.fetchLineAssets({
    line: 21, variant: "x64", pageSize: 100,
    fetcher: async raw => {
      assert.equal(new URL(raw).searchParams.get("page_size"), "20");
      return { status: 200, headers: {}, body: Buffer.from('{"error":"unexpected format"}') };
    }
  }), /must be an array/);
});

test("Java full refresh replaces reduced cache without restoring retired game defaults", async () => {
  const original = Manager.core.java.fetchAvailableVersionsForLine;
  const calls = [];
  const userDataDir = makeTempDir("maclauncher-java-catalog-");
  const settings = { defaultLine: 21, lines: { 21: { defaultVersion: "21.0.4+7", defaultVariant: "x64" } } };
  try {
    Manager.core.java.fetchAvailableVersionsForLine = async options => {
      calls.push(options.latestOnly);
      return {
        versions: options.latestOnly ? ["21.0.9+7"] : ["21.0.9+7", "21.0.4+7"],
        entriesByVersion: { "21.0.9+7": { arm64: {}, x64: {} }, "21.0.4+7": { x64: {} } }
      };
    };
    await Manager.refreshCatalog({ sectionId: "21", latestOnly: true, force: true });
    const full = await Manager.refreshCatalog({ sectionId: "21" });
    assert.deepEqual(calls, [true, false]);
    assert.deepEqual(full.versions, ["21.0.9+7", "21.0.4+7"]);
    const state = Manager.getState({ settings, userDataDir }).sections.find(section => section.id === "21");
    assert.equal(state.defaultVersion, "21.0.4+7");
    assert.equal(state.defaultVariant, "x64");
    assert.equal(state.catalog.latestAvailableVersion, "21.0.9+7");
    assert.equal(state.catalog.supportsLatestOnly, false);
    assert.equal(state.availabilityByVersion["21.0.4+7"].unavailable, false);
  } finally {
    Manager.core.java.fetchAvailableVersionsForLine = original;
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Java four-component versions retain their exact patch and build ordering", () => {
  const java = Manager.core.java;
  assert.equal(java.normalizeVersion("jdk-17.0.20.1+1"), "17.0.20.1+1");
  assert.equal(java.normalizeVersion("17.0.20+101"), "17.0.20+101");
  assert.equal(java.normalizeVersion("1.8.0_504-b01"), "8.0.504+1");
  assert.equal(java.versionMajor("17.0.20.1+1"), 17);
  assert.ok(java.compareVersions("17.0.20.1+1", "17.0.20+101") > 0);
  assert.ok(java.compareVersions("17.0.20.1+2", "17.0.20.1+1") > 0);
  assert.throws(() => java.normalizeVersion("17.0.20.1+1/unrelated"));
});

test("Java catalog uses OpenJDK versions and preserves official legacy SemVer alias lookups", async () => {
  const fetcher = async raw => {
    const architecture = new URL(raw).searchParams.get("architecture");
    const release = catalogRelease(20, architecture);
    release.release_name = "jdk-21.0.20.1+1";
    release.version_data = { openjdk_version: "21.0.20.1+1-LTS", semver: "21.0.20+101.0.LTS" };
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify([release])) };
  };
  const catalog = await Manager.core.java.fetchAvailableVersionsForLine({ line: 21, fetcher });
  assert.deepEqual(catalog.versions, ["21.0.20.1+1"]);
  const legacy = Manager.core.java.selectCatalogAsset({ lineCatalog: catalog, version: "21.0.20+101", hostArch: "arm64" });
  assert.equal(legacy.version, "21.0.20.1+1");
  assert.equal(legacy.asset.semverVersion, "21.0.20+101");
});

test("Java exact resolution keeps existing installed SemVer keys usable alongside canonical keys", () => {
  const userDataDir = makeTempDir("maclauncher-java-exact-version-");
  try {
    const legacyDir = createJavaInstall(userDataDir, { line: 17, version: "17.0.20+101", variant: "x64" });
    const canonicalDir = createJavaInstall(userDataDir, { line: 17, version: "17.0.20.1+1", variant: "x64" });
    const legacy = Manager.core.java.resolveBestInstalled({ userDataDir, line: 17, version: "17.0.20+101", variant: "x64", hostArch: "x64" });
    const canonical = Manager.core.java.resolveBestInstalled({ userDataDir, line: 17, version: "17.0.20.1+1", variant: "x64", hostArch: "x64" });
    assert.equal(legacy.installDir, legacyDir);
    assert.equal(canonical.installDir, canonicalDir);
    assert.equal(Manager.core.java.resolveBestInstalled({ userDataDir, line: 17, version: "17.0.20.2+1", hostArch: "x64" }), null);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
