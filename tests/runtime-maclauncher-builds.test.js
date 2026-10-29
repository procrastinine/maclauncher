const test = require("node:test");
const assert = require("node:assert/strict");
const Catalogs = require("../src/modules/shared/runtime/maclauncher-builds");

const repository = "ExampleOwner/runtime-builds";
const options = { projectId: "sample-runtime", repository };
function record(version = "1.2.3-macos-v2", arch = "arm64", projectId = options.projectId) {
  const tag = `${projectId}/v${version}/${arch}`;
  const filename = `${projectId}-${version}-${arch}.tar.gz`;
  return { schemaVersion: 2, id: projectId, version, arch,
    launcherArchitectures: arch === "universal" ? ["arm64", "x64"] : [arch], minimumMacOS: "13.0",
    manifestRelative: "manifest.json", manifestSha256: "1".repeat(64), sourceSha256: "2".repeat(64),
    updatePolicy: "manual", tag, asset: { filename, sha256: "3".repeat(64), bytes: 100,
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}` } };
}
function catalog(...packages) {
  return { schemaVersion: 2, projectId: options.projectId, updatePolicy: "manual", packages };
}

test("project catalogs preserve publisher ordering and filter by CPU after validating each record", () => {
  const value = catalog(record("2.0", "x64"), record("1.9", "universal"), record("1.8"));
  const result = Catalogs.validateProjectCatalog(value, { ...options, architecture: "arm64" });
  assert.deepEqual(result.packages.map(item => item.version), ["1.9", "1.8"]);
  assert.equal(result.packages[0].minimumMacOS, "13.0");
  value.packages[1].asset.url = "https://example.invalid/replaced";
  assert.equal(result.packages[0].asset.url.includes("github.com"), true);
  assert.equal(Object.isFrozen(result.packages[0].launcherArchitectures), true);
  const hidden = record("3.0", "x64", "other-runtime");
  const mixed = Catalogs.validateProjectCatalog(catalog(hidden, record()), { ...options, architecture: "arm64" });
  assert.deepEqual(mixed.packages.map(item => item.version), ["1.2.3-macos-v2"]);
  assert.deepEqual(mixed.unavailable, [], "A record for another CPU is not listed");
});

test("matching checksums cannot authorize mixed projects, swapped catalogs or repositories", () => {
  const foreign = record("1.2.3", "arm64", "other-runtime");
  const mixed = Catalogs.validateProjectCatalog(catalog(record(), foreign), options);
  assert.deepEqual(mixed.packages.map(item => item.version), ["1.2.3-macos-v2"]);
  assert.deepEqual(mixed.unavailable.map(item => item.version), ["1.2.3"]);
  assert.match(mixed.unavailable[0].reason, /invalid package/);
  assert.throws(() => Catalogs.validateProjectRecord(foreign, options), /invalid package/);
  assert.throws(() => Catalogs.validateProjectCatalog({ ...catalog(record()), projectId: "other-runtime" }, options), /selected project/);
  const swapped = record(); swapped.id = "other-runtime";
  assert.deepEqual(Catalogs.validateProjectCatalog(catalog(swapped), options).packages, []);
  assert.throws(() => Catalogs.validateProjectRecord(swapped, options), /invalid package/);
  const moved = Catalogs.validateProjectCatalog(catalog(record()), { ...options, repository: "OtherOwner/runtime-builds" });
  assert.deepEqual(moved.packages, []);
  assert.match(moved.unavailable[0].reason, /repository/);
});

test("release identities and every required package field are checked before exposure", () => {
  const mutations = [
    row => { row.tag = "sample-runtime-1.2.3-arm64"; },
    row => { row.tag = "other-runtime/v1.2.3/arm64"; },
    row => { row.asset.filename = "other-runtime-1.2.3-arm64.tar.gz"; },
    row => { row.asset.url = row.asset.url.replace(/%2F/g, "/"); },
    row => { row.asset.url += "?download=1"; },
    row => { row.asset.url = row.asset.url.replace("github.com", "github.com.example.invalid"); },
    row => { row.arch = "universal"; },
    row => { row.launcherArchitectures = ["arm64", "arm64"]; },
    row => { row.launcherArchitectures = ["aarch64"]; },
    row => { row.launcherArchitectures = []; },
    row => { row.launcherArchitectures = new Array(1); },
    row => { row.manifestRelative = "../manifest.json"; },
    row => { row.manifestRelative = "/manifest.json"; },
    row => { row.manifestRelative = "metadata\\manifest.json"; },
    row => { row.minimumMacOS = "13"; },
    row => { row.sourceSha256 = "not-a-checksum"; },
    row => { row.sourceSha256 = ["2".repeat(64)]; },
    row => { row.manifestSha256 = "0".repeat(63); },
    row => { row.asset.sha256 = "g".repeat(64); },
    row => { row.asset.bytes = 0; },
    row => { row.asset.bytes = 1.5; },
    row => { row.asset.bytes = 4 * 1024 ** 3 + 1; },
    row => { row.updatePolicy = "automatic"; },
    row => { row.schemaVersion = 1; }
  ];
  for (const mutate of mutations) {
    const row = record(); mutate(row);
    assert.throws(() => Catalogs.validateProjectRecord(row, options));
    const result = Catalogs.validateProjectCatalog(catalog(row, record("1.0")), options);
    assert.deepEqual(result.packages.map(item => item.version), ["1.0"], "Other records remain usable");
    assert.deepEqual(result.unavailable.map(item => item.version), [row.version], "The record stays listed with its reason");
  }
  const repeated = Catalogs.validateProjectCatalog(catalog(record(), record()), options);
  assert.deepEqual(repeated.packages, []);
  assert.match(repeated.unavailable[0].reason, /repeats/);
  for (const value of [catalog(...new Array(1)), { ...catalog(), packages: new Array(1) }])
    assert.deepEqual(Catalogs.validateProjectCatalog(value, options).unavailable, [], "A record without a version cannot be listed");
  assert.throws(() => Catalogs.validateProjectCatalog({ ...catalog(record()), updatePolicy: "automatic" }, options), /update policy/);
});

test("a later record schema or launcher contract is listed with a reason; added fields are ignored", () => {
  const later = { ...record("2.0"), schemaVersion: 3 }; delete later.asset;
  const contract = { ...record("3.0"), launcherContract: 2 };
  const additive = { ...record("4.0"), launcherContract: 1, futureCapability: { values: [1, 2] } };
  const invalid = { ...record("5.0"), launcherContract: 0 };
  const result = Catalogs.validateProjectCatalog({ ...catalog(record("1.0"), later, contract, additive, invalid), schemaVersion: 3, notes: "added" }, options);
  assert.deepEqual(result.packages.map(item => item.version), ["1.0", "4.0"]);
  assert.equal(result.packages[1].futureCapability, undefined);
  assert.equal(result.packages[1].launcherContract, 1);
  assert.deepEqual(result.unavailable.map(item => [item.version, item.reason]), [["2.0", "Requires a newer MacLauncher."],
    ["3.0", "Requires a newer MacLauncher."], ["5.0", "The runtime launcher contract is invalid."]]);
  assert.throws(() => Catalogs.validateProjectRecord(contract, options), /newer MacLauncher/);
  assert.equal(Catalogs.validateProjectRecord(contract, { ...options, launcherContract: 2 }).launcherContract, 2);
  assert.deepEqual(Catalogs.validateProjectCatalog(catalog(contract), { ...options, launcherContract: 2 }).packages.map(item => item.version), ["3.0"]);
  assert.throws(() => Catalogs.validateProjectCatalog({ ...catalog(record()), schemaVersion: 1 }, options), /selected project/);
  assert.throws(() => Catalogs.validateProjectCatalog(catalog(record()), { ...options, launcherContract: 0 }), /launcher contract/);
});

test("unsafe versions and invalid source identities never construct a catalog URL or download", async () => {
  for (const value of ["../1", "1/2", "v1..2", "1.2.", "1.2.lock", "1+build", "1%2F2", "1\n2", "a".repeat(129)]) {
    assert.throws(() => Catalogs.validateProjectRecord(record(value), options));
    const result = Catalogs.validateProjectCatalog(catalog(record(value)), options);
    assert.deepEqual([result.packages, result.unavailable], [[], []]);
  }
  for (const value of ["../sample", "Sample", "sample/runtime", "a".repeat(81)])
    assert.throws(() => Catalogs.catalogUrl({ ...options, projectId: value }));
  for (const value of [undefined, "https://github.com/owner/repo", "owner/../repo", "owner/repo?branch=other", "owner/repo."])
    assert.throws(() => Catalogs.catalogUrl({ ...options, repository: value }));
  let calls = 0;
  const request = async () => { calls++; throw new Error("unexpected request"); };
  await assert.rejects(Catalogs.fetchProjectCatalog({ ...options, architecture: "universal" }, { fetchUrlBuffer: request }), /architecture/);
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(Catalogs.fetchProjectCatalog({ ...options, signal: canceled.signal }, { fetchUrlBuffer: request }), /canceled/);
  assert.equal(calls, 0);
});

test("only explicit refresh fetches the fixed project URL; malformed responses expose no records", async () => {
  let calls = 0;
  const signal = new AbortController().signal;
  const fetchUrlBuffer = async (url, request) => {
    calls++;
    assert.equal(url, "https://raw.githubusercontent.com/ExampleOwner/runtime-builds/main/catalogs/sample-runtime.json");
    assert.equal(request.signal, signal);
    assert.equal(request.maxRedirects, 0);
    return { status: 200, body: Buffer.from(JSON.stringify(catalog(record()))) };
  };
  Catalogs.catalogUrl(options);
  Catalogs.validateProjectCatalog(catalog(record()), options);
  assert.equal(calls, 0);
  const result = await Catalogs.fetchProjectCatalog({ ...options, signal }, { fetchUrlBuffer });
  assert.equal(calls, 1);
  assert.equal(result.packages.length, 1);
  assert.equal(result.updatePolicy, "manual");
  for (const response of [{ status: 404, body: Buffer.from("{}") }, { status: 200, body: "{}" },
    { status: 200, body: Buffer.from("not-json") }, { status: 200, body: Buffer.from(JSON.stringify({ ...catalog(), projectId: "other-runtime" })) }])
    await assert.rejects(Catalogs.fetchProjectCatalog(options, { fetchUrlBuffer: async () => response }));
  const foreign = await Catalogs.fetchProjectCatalog(options, { fetchUrlBuffer: async () =>
    ({ status: 200, body: Buffer.from(JSON.stringify(catalog(record("2", "arm64", "other-runtime")))) }) });
  assert.deepEqual([foreign.packages, foreign.unavailable.map(item => item.version)], [[], ["2"]]);
});
