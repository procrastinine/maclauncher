const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const JavaCore = require("../src/modules/java/runtime/java-runtime");
const VineflowerCore = require("../src/modules/java/runtime/vineflower-runtime");

function freshManager(t) {
  const filename = require.resolve("../src/modules/java/runtime/java-runtime-manager");
  const previous = require.cache[filename];
  delete require.cache[filename];
  t.after(() => {
    if (previous) require.cache[filename] = previous;
    else delete require.cache[filename];
  });
  return require(filename);
}

const cases = [
  {
    name: "Temurin", section: "17", core: JavaCore, fetch: "fetchAvailableVersionsForLine",
    versions: ["17.0.20.1+1", "17.0.18+1"], nextVersion: "17.0.21+1",
    result(versions) {
      return {
        versions, source: "https://example.test/temurin/releases",
        entriesByVersion: Object.fromEntries(versions.map(version => [version, {
          arm64: { version, url: `https://example.test/arm64/${version}.tar.gz` },
          x64: { version, url: `https://example.test/x64/${version}.tar.gz` }
        }]))
      };
    },
    install(userDataDir, version) {
      const directory = path.join(userDataDir, "runtimes", "java", "17", version, "x64", "bin");
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "java"), "");
    }
  },
  {
    name: "Vineflower", section: "vineflower", core: VineflowerCore, fetch: "fetchAvailableVersions",
    versions: ["1.11.0", "1.10.1"], nextVersion: "1.12.0",
    result(versions) {
      return {
        versions, source: "https://example.test/vineflower/releases",
        releasesByVersion: Object.fromEntries(versions.map(version => [version, {
          release: { tag_name: version },
          asset: { browser_download_url: `https://example.test/${version}.jar` }
        }]))
      };
    },
    install(userDataDir, version) {
      const directory = path.join(userDataDir, "runtimes", "vineflower", version);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "vineflower.jar"), "");
    }
  }
];

for (const config of cases) {
  test(`${config.name} preserves valid releases, install metadata and defaults after a failed Reload`, async t => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "java-refresh-retention-"));
    t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
    const manager = freshManager(t);
    const version = config.versions[1];
    const settings = manager.applySettingsUpdate("setDefault", {
      sectionId: config.section, version, variant: "x64"
    }, {});
    config.install(userDataDir, version);
    const read = () => manager.getState({ settings, userDataDir }).sections.find(section => section.id === config.section);
    let now = 1900000000000, calls = 0, phase = "first";
    t.mock.method(Date, "now", () => now);
    const firstResult = config.result(config.versions);
    t.mock.method(config.core, config.fetch, async () => {
      calls++;
      if (phase === "error") throw new Error("Release query failed");
      return phase === "first" ? firstResult : config.result([config.nextVersion]);
    });
    const options = { sectionId: config.section, latestOnly: false };
    const initial = read();
    assert.equal(initial.catalog.status, "idle");
    assert.deepEqual(initial.catalog.versions, []);
    assert.equal(initial.defaultVersion, version);
    assert.equal(calls, 0);

    const first = await manager.refreshCatalog(options);
    await manager.refreshCatalog(options);
    assert.equal(calls, 1, "only a successful matching catalog satisfies the TTL");
    const ready = read();
    now += 1000;
    phase = "error";
    await assert.rejects(manager.refreshCatalog({ ...options, force: true, latestOnly: true }), /Release query failed/);
    const failed = read();
    assert.equal(failed.catalog.status, "error");
    assert.equal(failed.catalog.error, "Release query failed");
    assert.deepEqual(failed.catalog.versions, first.versions);
    assert.equal(failed.catalog.fetchedAt, first.fetchedAt);
    assert.equal(failed.catalog.source, first.source);
    if (config.section !== "vineflower") {
      assert.equal(failed.catalog.mode, "all", "an unsuccessful query cannot change the retained mode");
      assert.deepEqual(failed.availabilityByVersion, ready.availabilityByVersion);
      assert.equal(failed.defaultVariant, "x64");
    }
    assert.equal(failed.defaultVersion, version);
    assert.deepEqual(failed.installed, ready.installed);
    read(); read();
    assert.equal(calls, 2, "offline state reads cannot retry the query");

    t.mock.method(config.core, "installVersion", async input => {
      assert.equal(input.version, version);
      if (config.section === "vineflower") assert.strictEqual(input.releasesByVersion, firstResult.releasesByVersion);
      else {
        assert.strictEqual(input.lineCatalog.entriesByVersion, firstResult.entriesByVersion);
        assert.equal(input.variant, "x64");
      }
      return { version };
    });
    await manager.installRuntime({ sectionId: config.section, userDataDir, version, variant: "x64" });
    assert.equal(calls, 2, "retained asset metadata remains usable without rediscovery");

    now += 1000;
    phase = "next";
    const next = await manager.refreshCatalog(options);
    assert.equal(calls, 3, "failed queries cannot satisfy the success TTL");
    assert.equal(next.status, "success");
    assert.equal(next.error, null);
    assert.equal(next.fetchedAt, now);
    assert.deepEqual(next.versions, [config.nextVersion], "successful Reload replaces previous rows");
    const entries = next.entriesByVersion || next.releasesByVersion;
    assert.deepEqual(Object.keys(entries), [config.nextVersion], "replacement removes obsolete install metadata");
    assert.equal(read().defaultVersion, version);
    await manager.refreshCatalog(options);
    assert.equal(calls, 3);
    now += 6 * 60 * 60 * 1000;
    await manager.refreshCatalog(options);
    assert.equal(calls, 4, "the successful catalog expires after six hours");
  });

  test(`${config.name} initial query failure leaves no successful fetch timestamp and allows an immediate retry`, async t => {
    const manager = freshManager(t);
    let calls = 0;
    t.mock.method(config.core, config.fetch, async () => {
      calls++;
      if (calls === 1) throw new Error("Release query failed");
      return config.result(config.versions);
    });
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "java-refresh-retry-"));
    t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
    const options = { sectionId: config.section };
    await assert.rejects(manager.refreshCatalog(options), /Release query failed/);
    const failed = manager.getState({ userDataDir, settings: {} }).sections.find(section => section.id === config.section).catalog;
    assert.equal(failed.fetchedAt, null);
    assert.equal(failed.source, null);
    assert.deepEqual(failed.versions, []);
    assert.equal(failed.status, "error");
    assert.equal(calls, 1);
    const next = await manager.refreshCatalog(options);
    assert.equal(calls, 2);
    assert.equal(next.status, "success");
    assert.deepEqual(next.versions, config.versions);
  });
}

for (const fails of [false, true]) {
  test(`Temurin queues All versions after a pending ${fails ? "failed " : ""}Latest query`, async t => {
    const manager = freshManager(t);
    const config = cases[0], calls = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    t.mock.method(JavaCore, "fetchAvailableVersionsForLine", async ({ latestOnly }) => {
      calls.push(latestOnly);
      if (latestOnly) {
        await gate;
        if (fails) throw new Error("Latest query failed");
      }
      return config.result(latestOnly ? [config.versions[0]] : config.versions);
    });
    const latest = manager.refreshCatalog({ sectionId: "17", latestOnly: true });
    const handledLatest = fails ? assert.rejects(latest, /Latest query failed/) : latest;
    const all = manager.refreshCatalog({ sectionId: "17", latestOnly: false });
    await Promise.resolve();
    assert.deepEqual(calls, [true]);
    release();
    await handledLatest;
    const complete = await all;
    assert.deepEqual(calls, [true, false]);
    assert.equal(complete.mode, "all");
    assert.deepEqual(complete.versions, config.versions);
    await manager.refreshCatalog({ sectionId: "17", latestOnly: false });
    assert.deepEqual(calls, [true, false]);
  });
}

test("Temurin names the managed provider without changing Java IDs or version groups", t => {
  const manager = freshManager(t);
  const manifest = require("../src/modules/java/manifest.json");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "java-provider-label-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  assert.equal(manager.id, "java");
  assert.equal(manager.label, "Temurin");
  assert.equal(manifest.label, "Java");
  assert.equal(manifest.runtime.managerUi.java.tabLabel, "Temurin");
  assert.equal(manifest.runtime.manager.java, "java");
  assert.deepEqual(manager.getState({ userDataDir, settings: {} }).sections.map(section => [section.id, section.label]), [
    ["8", "Java 8"], ["11", "Java 11"], ["17", "Java 17"], ["21", "Java 21"], ["25", "Java 25"], ["vineflower", "Vineflower"]
  ]);
});
