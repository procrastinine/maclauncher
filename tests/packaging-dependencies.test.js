const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const builderRequire = createRequire(require.resolve("app-builder-lib/package.json"));
const packagingGet = builderRequire("@electron/get");
const getRequire = createRequire(builderRequire.resolve("@electron/get"));
const gotRequire = createRequire(getRequire.resolve("got"));
const cacheRequire = createRequire(gotRequire.resolve("cacheable-request"));
const CachePolicy = cacheRequire("http-cache-semantics");

test("legacy packaging concurrency pool works with the maintained semver release", async () => {
  const pool = builderRequire("tiny-async-pool");
  let active = 0;
  let maximum = 0;
  const result = await pool(2, [1, 2, 3, 4], async value => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8]);
  assert.equal(maximum, 2);
  assert.equal(active, 0);
});

for (const version of ["1.3.2", "1.3.5", "44.5.1", "45.0.0-beta.1"]) {
  test(`packaging downloader verifies checksums for Electron ${version}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "maclauncher-packaging-deps-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bytes = Buffer.from("Synthetic offline Electron artifact\n");
    const artifact = `fixture-v${version}.zip`;
    const checksum = createHash("sha256").update(bytes).digest("hex");
    let downloads = 0;
    const options = {
      version, artifactName: artifact, isGeneric: true,
      cacheRoot: path.join(root, "cache"), tempDirectory: root,
      checksums: { [artifact]: checksum },
      downloader: {
        download: async (_url, destination) => {
          downloads++;
          await fs.writeFile(destination, bytes);
        }
      }
    };
    const downloaded = await packagingGet.downloadArtifact(options);
    assert.deepEqual(await fs.readFile(downloaded), bytes);
    assert.equal(downloads, 1);

    // Exercise the same semver-controlled validation branches with bad bytes.
    await assert.rejects(packagingGet.downloadArtifact({
      ...options, cacheRoot: path.join(root, "bad-cache"),
      downloader: { download: (_url, destination) => fs.writeFile(destination, "corrupted") }
    }), /checksum|hash/i);
  });
}

test("packaging HTTP cache cannot reuse responses with wildcard Vary fields", () => {
  const request = { headers: { weather: "ok" } };
  for (const vary of ["*", "* ", " *", " * ", "*,", "*, weather", "weather, *"]) {
    const policy = new CachePolicy(request, {
      status: 200, headers: { "cache-control": "max-age=600", vary }
    });
    assert.equal(policy.satisfiesWithoutRevalidation(request), false, vary);
    assert.equal(CachePolicy.fromObject(policy.toObject()).satisfiesWithoutRevalidation(request), false, vary);
  }
});

test("packaging HTTP cache preserves ordinary Vary matches and ignores inherited header values", () => {
  const request = { headers: { weather: "ok" } };
  const policy = new CachePolicy(request, {
    status: 200, headers: { "cache-control": "max-age=600", vary: "weather" }
  });
  assert.equal(policy.satisfiesWithoutRevalidation(request), true);
  assert.equal(policy.satisfiesWithoutRevalidation({ headers: { weather: "bad" } }), false);
  assert.equal(policy.satisfiesWithoutRevalidation({ headers: Object.create({ weather: "ok" }) }), false);
});
