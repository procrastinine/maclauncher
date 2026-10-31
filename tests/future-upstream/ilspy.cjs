const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { writeZipArchive } = require("../helpers/zip-fixture");
const { managedAssembly } = require("../helpers/fna-assembly");

// NuGet's service index, ilspycmd's registration pages and catalog leaves.
const INDEX = "https://api.nuget.org/v3/index.json", BASE = "https://api.nuget.org/v3/registration5-gz-semver2/";
const FILES = ["ilspycmd.dll", "ilspycmd.deps.json", "ilspycmd.runtimeconfig.json", "ICSharpCode.Decompiler.dll", "Mono.Cecil.dll"];
const catalogUrl = version => `https://api.nuget.org/v3/catalog0/data/2026.01.01.00.00.00/ilspycmd.${version}.json`;
const flat = version => `https://api.nuget.org/v3-flatcontainer/ilspycmd/${version}/ilspycmd.${version}.nupkg`;
function leaf(version, { folders = ["tools/net10.0/any/"], entries = true, hash = version, packageContent = flat(version), listed = true } = {}) {
  const details = { "@id": catalogUrl(version), "@type": ["PackageDetails", "catalog:Permalink"], id: "ilspycmd", version, listed,
    authors: "ICSharpCode", published: "2026-01-01T00:00:00+00:00", licenseExpression: "MIT", packageHashAlgorithm: "SHA512",
    packageHash: crypto.createHash("sha512").update(hash).digest("base64"), packageSize: 4632113,
    repository: { type: "git", url: "https://github.com/icsharpcode/ILSpy", commit: crypto.createHash("sha1").update(version).digest("hex") },
    ...(entries ? { packageEntries: folders.flatMap(folder => FILES.map(name => ({ "@type": "PackageEntry", fullName: folder + name, name, length: 1024, compressedLength: 512 })))
      .concat([{ "@type": "PackageEntry", fullName: "ilspycmd.nuspec", name: "ilspycmd.nuspec", length: 100, compressedLength: 80 }]) } : {}) };
  return { details, item: { "@id": `${BASE}ilspycmd/${version}.json`, "@type": "Package", commitTimeStamp: "2026-01-01T00:00:00Z",
    catalogEntry: { "@id": catalogUrl(version), "@type": "PackageDetails", id: "ilspycmd", version, listed, authors: "ICSharpCode" },
    packageContent, registration: `${BASE}ilspycmd/index.json` } };
}
function routes(leaves) {
  const sorted = leaves.slice().sort((a, b) => a.details.version.localeCompare(b.details.version, "en", { numeric: true }));
  return { [INDEX]: { version: "3.0.0", resources: [{ "@id": "https://api.nuget.org/v3-flatcontainer/", "@type": "PackageBaseAddress/3.0.0" },
    { "@id": "https://api.nuget.org/v3/registration5-semver1/", "@type": "RegistrationsBaseUrl" },
    { "@id": BASE, "@type": "RegistrationsBaseUrl/3.6.0", comment: "Includes SemVer 2.0.0 packages" }] },
  [`${BASE}ilspycmd/index.json`]: { "@id": `${BASE}ilspycmd/index.json`, count: 1, items: [{ "@id": `${BASE}ilspycmd/index.json#page/0`,
    count: sorted.length, lower: sorted[0].details.version, upper: sorted.at(-1).details.version, items: sorted.map(row => row.item) }] },
  ...Object.fromEntries(leaves.map(row => [catalogUrl(row.details.version), row.details])) };
}
const current = [leaf("11.1.0.9782"), leaf("9.1.0.7988", { folders: ["tools/net8.0/any/"] })];
const scenarios = {
  newVersion: { routes: routes([leaf("12.0.0.10000"), ...current]), version: "12.0.0.10000", usable: true },
  // A later package targets a newer .NET and moves its tool one folder deeper.
  renamedAsset: { routes: routes([leaf("12.0.0.10000", { folders: ["tools/net11.0/any/cli/"] }), ...current]), version: "12.0.0.10000", usable: true },
  addedAsset: { routes: routes([leaf("12.0.0.10000", { folders: ["tools/net8.0/any/", "tools/net10.0/any/"] }), ...current]), version: "12.0.0.10000", usable: true },
  movedPackage: { routes: routes([leaf("12.0.0.10000", { packageContent: "https://api.nuget.org/v3-flatcontainer2/ilspycmd/12.0.0.10000/ilspycmd.12.0.0.10000.nupkg" }), ...current]),
    version: "12.0.0.10000", usable: true },
  withoutPackageListing: { routes: routes([leaf("12.0.0.10000", { entries: false }), ...current]), version: "12.0.0.10000", usable: true },
  replacedFile: { routes: routes([leaf("11.1.0.9782", { hash: "replaced" }), current[1]]), version: "11.1.0.9782", usable: true },
  deletedRelease: { routes: routes([current[0], leaf("9.1.0.7988", { folders: ["tools/net8.0/any/"], listed: false })]), version: "11.1.0.9782", usable: true, deleted: "9.1.0.7988" }
};
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "future-ilspy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

module.exports = { managers: ["ilspy"], current: routes(current), scenarios, checks: {
  "an ILSpy package whose tool moved deeper and whose configuration lists its frameworks installs with its own .NET"(t) {
    const Tool = require("../../src/modules/shared/runtime/managed-decompiler");
    const root = directory(t), archive = path.join(root, "ilspy.nupkg"), prefix = "tools/net11.0/any/cli/";
    const entries = ["ilspycmd", "ICSharpCode.Decompiler"].map(name => ({ name: prefix + name + ".dll",
      data: managedAssembly({ name, version: [12, 0, 0, 0], framework: ".NETCoreApp,Version=v11.0" }) }));
    entries.push({ name: prefix + "ilspycmd.deps.json", data: "{}" }, { name: "ilspycmd.nuspec", data: "<package/>" },
      { name: prefix + "ilspycmd.runtimeconfig.json", data: JSON.stringify({ runtimeOptions: { tfm: "net11.0",
        frameworks: [{ name: "Microsoft.NETCore.App", version: "11.0.0" }], configProperties: { "System.Runtime.TieredPGO": true } } }) });
    writeZipArchive(archive, entries);
    const files = path.join(root, "files"); fs.mkdirSync(files);
    assert.deepEqual(Tool.__test.extractPackage(archive, files, { version: "12.0.0", framework: null }), { framework: "net11.0", minimumRuntime: "11.0.0" });
    assert.ok(fs.existsSync(path.join(files, "ilspycmd.dll")));
  },
  async "the .NET tool host follows Microsoft's runtime file wherever it is published"(t, Harness) {
    const Host = require("../../src/modules/shared/runtime/dotnet-tool-host");
    const version = "11.0.3", hash = "f".repeat(128);
    Harness.network.routes = { "https://builds.dotnet.microsoft.com/dotnet/release-metadata/11.0/releases.json": { "channel-version": "11.0", "future-field": true,
      releases: [{ "release-version": version, runtime: { version, "vs-version": "", files: [
        { name: "dotnet-runtime-osx-arm64.pkg", rid: "osx-arm64", url: `https://download.visualstudio.microsoft.com/runtime/${version}/arm64.pkg`, hash },
        { name: `dotnet-runtime-${version}-osx-arm64.tar.gz`, rid: "osx-arm64", url: `https://download.visualstudio.microsoft.com/runtime/${version}/osx-arm64.tar.gz`, hash: hash.toUpperCase(), akams: "" }] } }] } };
    const pin = await Host.__test.selectPin({ framework: "net11.0", minimumVersion: "11.0.0", architecture: "arm64" });
    assert.equal(pin.version, version); assert.equal(pin.sha512, hash); assert.match(pin.url, /osx-arm64\.tar\.gz$/);
  }
} };
