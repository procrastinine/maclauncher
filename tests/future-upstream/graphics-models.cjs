const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { githubRelease, githubRoutes } = require("../helpers/future-upstream.cjs");
const History = require("../../src/core/steam-version-history");
const SteamClient = require("../../src/modules/shared/reshade/steam-client-models");

// Lossless Scaling's model versions are the Steam depot manifests SteamDB has
// seen; Refresh reads that page. Model and tool downloads outside runtime
// catalogs follow: SteamCMD's managed package from Valve's manifest, and model
// archives published as GitHub release assets that the publisher may
// replace. Revision-pinned model files (raw GitHub and Hugging Face URLs
// naming a commit) are immutable; every model file keeps its identity checksum.
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function temporary(t, prefix) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}
// A minimal arm64 Mach-O header: an executable stands in for Valve's steamcmd,
// a library for one of its native siblings.
function machO(fileType = 2) {
  const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(fileType, 12); return bytes;
}
// A stored zip made on a Unix host, so each entry keeps its permissions.
function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, content, mode = 0o644] of files) {
    const nameBytes = Buffer.from(name), data = Buffer.from(content), header = Buffer.alloc(30), entry = Buffer.alloc(46);
    const crc = require("node:zlib").crc32(data);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(nameBytes.length, 26);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, data); central.push(entry, nameBytes); offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
// Valve's SteamCMD manifest and its content-addressed part files. The first
// part is the bootstrap package.
function steamcmdRoutes(location, version, parts) {
  const origin = location.replace(/[^/]+$/, ""), routes = {};
  const blocks = Object.entries(parts).map(([name, bytes], index) => {
    const file = `${name}.zip.${crypto.createHash("sha1").update(bytes).digest("hex")}`;
    routes[origin + file] = bytes;
    return `\t"${name}"\n\t{\n\t\t"file"\t\t"${file}"\n\t\t"size"\t\t"${bytes.length}"\n\t\t"sha2"\t\t"${hash(bytes)}"\n` +
      `${index ? "" : '\t\t"IsBootstrapperPackage"\t\t"1"\n'}\t}\n`;
  });
  routes[location] = `"osx"\n{\n\t"version"\t\t"${version}"\n${blocks.join("")}}\n`;
  return routes;
}
// A GitHub release whose one asset has the given bytes and published digest.
function releaseRoutes(repository, tag, name, bytes) {
  const release = githubRelease(repository, tag, [name]);
  release.assets[0] = { ...release.assets[0], size: bytes.length, digest: "sha256:" + hash(bytes) };
  return { ...githubRoutes(repository, [release]), [release.assets[0].browser_download_url]: bytes };
}

// SteamDB's manifest history: a "Previously seen manifests" table, newest
// first, each row with its date and manifest ID. `markup` adds what the page
// may add later: more columns and attributes, and an unrelated table of long
// numbers (file hashes) under another heading.
const historyUrl = History.historyUrl(SteamClient.APP_ID, SteamClient.DEPOT_ID);
function historyPage(rows, { heading = true, markup = false } = {}) {
  const cells = ([id, date]) => `<tr${markup ? ` data-branch="public" class="future-row"` : ""}><td data-time="${Date.parse(date) / 1000}">` +
    `<time datetime="${date}">${date.slice(0, 10)}</time></td><td>${markup ? "<span>3 days ago</span></td><td>" : ""}` +
    `<a href="/depot/${SteamClient.DEPOT_ID}/history/?changeid=M:${id}">${id}</a></td>${markup ? "<td>public</td>" : ""}</tr>`;
  const table = `<table class="table" id="manifests"><thead><tr><th>Seen date</th><th>Manifest ID</th></tr></thead><tbody>${rows.map(cells).join("")}</tbody></table>`;
  return `<html><body><h1>Lossless Scaling depot</h1>${heading ? "<h2>Previously seen manifests</h2>" : ""}${heading ? table.replace(' id="manifests"', "") : table.replace('id="manifests"', 'id="table-manifests"')}` +
    (markup ? `<h2>Files</h2><table><tr><td>Lossless.dll</td><td>1234567890123456789012</td><td>${"f".repeat(40)}</td></tr></table>` : "") + "</body></html>";
}
const manifests = [["7006241187290911846", "2026-10-01T12:00:00Z"], ["5214377926349104981", "2026-08-15T09:30:00Z"], ["3360874412270650315", "2026-05-02T18:45:00Z"]];
const added = ["8811302775406012345", "2026-11-12T08:00:00Z"], version = row => "steam-manifest-" + row[0];
// A listed manifest is installable when Steam for Mac can download it; otherwise
// it is listed with the reason.
const usable = process.platform === "darwin" && Boolean(SteamClient.findClient());

module.exports = {
  managers: ["graphics-models"],
  current: { [historyUrl]: historyPage(manifests) },
  scenarios: {
    newVersion: { routes: { [historyUrl]: historyPage([added, ...manifests]) }, version: version(added), usable },
    // SteamDB stops showing the oldest manifest.
    deletedRelease: { routes: { [historyUrl]: historyPage(manifests.slice(0, -1)) }, version: version(manifests[0]), usable,
      deleted: version(manifests.at(-1)) },
    unknownMarkup: { routes: { [historyUrl]: historyPage(manifests, { markup: true }) }, version: version(manifests[0]), usable },
    // The table keeps its ID without the heading above it.
    tableWithoutHeading: { routes: { [historyUrl]: historyPage(manifests, { heading: false }) }, version: version(manifests[0]), usable }
  },
  checks: {
    "a later SteamCMD manifest with replaced, added and foldered parts installs with Valve's Developer ID check": async (t, Harness) => {
      const Source = require("../../src/modules/shared/reshade/steamcmd-source"), DeveloperId = require("../../src/modules/shared/runtime/developer-id");
      const Manager = require("../../src/modules/shared/reshade/runtime/steamcmd-manager").create(), Steam = require("../../src/modules/shared/reshade/steam-models");
      const userDataDir = path.join(temporary(t, "future-steamcmd-"), "profile"); fs.mkdirSync(userDataDir);
      const executable = build => Buffer.concat([machO(), Buffer.from(Source.BOOTSTRAP_ARGUMENTS.join("\0") + "\0" + build)]);
      const libraries = zip(Source.LIBRARIES.map(name => [name, machO(6), 0o755]));
      // codesign's answer: Valve's signature on every bootstrap except a refused build.
      const signed = [], refused = hash(executable("unsigned rebuild"));
      t.mock.method(DeveloperId, "verifyDeveloperId", async (file, team) => {
        signed.push([path.basename(file), team]);
        if (hash(fs.readFileSync(file)) === refused) throw new Error("The downloaded code is not validly signed by Developer ID team " + team + ".");
        return { teamIdentifier: team };
      });
      const install = async (version, parts) => {
        Harness.network.routes = steamcmdRoutes(Source.location, version, parts);
        try { await Manager.refreshCatalog({ userDataDir, force: true }); return await Manager.installRuntime({ userDataDir, version }); }
        finally { Harness.network.routes = null; }
      };
      const earlier = await install("1794537082", { steamcmd_osx: zip([["steamcmd", executable("1794537082"), 0o755]]), steamcmd_bins_osx: libraries });
      // The later package rebuilds the bootstrap, adds a part and keeps another part's files in a folder.
      const later = await install("1794537083", { steamcmd_osx: zip([["steamcmd", executable("1794537083"), 0o755]]), steamcmd_bins_osx: libraries,
        steamcmd_public_all: zip([["public/steambootstrapper_english.txt", "\"lang\" { }"]]), steamcmd_siteserverui_osx: zip([["siteserverui/index.html", "<html></html>"]]) });
      assert.deepEqual(signed, [["steamcmd", "MXGJJ98X76"], ["steamcmd", "MXGJJ98X76"]]);
      assert.deepEqual(fs.readFileSync(later.executablePath), executable("1794537083"));
      for (const file of ["public/steambootstrapper_english.txt", "siteserverui/index.html", ...Source.LIBRARIES])
        assert.ok(fs.existsSync(path.join(path.dirname(later.executablePath), file)), file);
      // A bootstrap without Valve's signature installs nothing.
      await assert.rejects(install("1794537084", { steamcmd_osx: zip([["steamcmd", executable("unsigned rebuild"), 0o755]]), steamcmd_bins_osx: libraries }),
        /Developer ID team MXGJJ98X76/);
      assert.deepEqual(Manager.core.listInstalled(userDataDir).map(row => row.version).sort(), ["1794537082", "1794537083"]);
      assert.deepEqual(fs.readFileSync(earlier.executablePath), executable("1794537082"));
      // A Steam download reuses the installed package offline, without another question.
      const requests = Harness.network.requests.length;
      const result = await Steam.acquire({ userDataDir, settings: { runtimes: { steamcmd: { defaultVersion: "1794537083" } } },
        confirmRuntimeInstall: () => assert.fail("an installed SteamCMD needs no download") }, {
        manager: Manager,
        authenticate: async session => {
          assert.deepEqual(fs.readFileSync(path.join(session, "tools", "steamcmd")), executable("1794537083"), "the selected package runs");
          assert.ok(fs.existsSync(path.join(session, "tools", "public", "steambootstrapper_english.txt")));
          fs.writeFileSync(path.join(session, "content", "Lossless.dll"), "dll");
        }, importModel: async () => ({ version: "3.2.2.0" }) });
      assert.equal(result.version, "3.2.2.0"); assert.equal(Harness.network.requests.length, requests);
    },
    "a replaced GitHub release checkpoint archive is verified by the publisher's new digest": async (t, Harness) => {
      const Source = require("../../src/modules/shared/reshade/neural/checkpoint-source");
      const { writeZipArchive } = require("../helpers/zip-fixture");
      const root = temporary(t, "future-checkpoint-"), weights = Buffer.alloc(2048, 3), entry = "updated_weights/up2x-latest-conservative.pth";
      const build = (name, extra) => { const file = path.join(root, name); writeZipArchive(file, [{ name: entry, data: weights, deflate: true }, ...extra]); return fs.readFileSync(file); };
      const original = build("original.zip", []), replaced = build("replaced.zip", [{ name: "updated_weights/README.txt", data: "republished with notes" }]);
      const url = "https://github.com/bilibili/ailab/releases/download/Real-CUGAN/updated_weights.zip";
      const row = { transport: "zip-entry", url, file: "model.pth", bytes: weights.length, sha256: hash(weights),
        archive: { entry, bytes: original.length, sha256: hash(original) } };
      Harness.network.routes = releaseRoutes("bilibili/ailab", "Real-CUGAN", "updated_weights.zip", replaced);
      await Source.downloadEntry(row, path.join(root, "selected.pth"));
      assert.deepEqual(fs.readFileSync(path.join(root, "selected.pth")), weights);
      // Without the publisher's release list, the archive downloads from its URL
      // with its SHA-256 recorded; the model entry keeps its declared size.
      Harness.network.routes = { [url]: replaced };
      await Source.downloadEntry(row, path.join(root, "listed-elsewhere.pth"));
      assert.deepEqual(fs.readFileSync(path.join(root, "listed-elsewhere.pth")), weights);
      // A publisher digest that the download does not match installs nothing.
      Harness.network.routes = { ...releaseRoutes("bilibili/ailab", "Real-CUGAN", "updated_weights.zip", original), [url]: replaced };
      await assert.rejects(Source.downloadEntry(row, path.join(root, "mismatch.pth")), /does not match the (size|checksum) its publisher lists/);
    },
    "a replaced DLSSMac release archive is verified by the publisher's new digest and its model identity": async (t, Harness) => {
      const Setup = require("../../src/modules/shared/reshade/neural/setup"), Models = require("../../src/modules/shared/reshade/neural/models");
      const { writeZipArchive } = require("../helpers/zip-fixture");
      const root = temporary(t, "future-dlssmac-"), userDataDir = path.join(root, "profile"); fs.mkdirSync(userDataDir);
      const weights = Buffer.alloc(4096, 7), manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, identifier: "org.example.download",
        architecture: "mlxdlss.neural-rendering-transformer.v1",
        inputs: [{ name: "color", dataType: "float32", layout: "nhwc", shape: [1, "height", "width", 16] }],
        outputs: [{ name: "color", dataType: "float32", layout: "nhwc", shape: [1, "height", "width", 4] }], state: { kind: "stateless" },
        weights: { file: "weights.safetensors", sha256: hash(weights), tensors: require("../helpers/neural-model-contract").nrTensors() } }));
      const prefix = "DLSSMac.app/Contents/Resources/models/Model.dlssmodel/", archive = path.join(root, "release.zip");
      writeZipArchive(archive, [{ name: prefix + "manifest.json", data: manifest }, { name: prefix + "weights.safetensors", data: weights },
        { name: "DLSSMac.app/Contents/Resources/NOTICE", data: "Model terms" }, { name: "DLSSMac.app/Contents/Info.plist", data: "republished" }]);
      const bytes = fs.readFileSync(archive), declared = Setup.sourceFor();
      // The declared size and checksum describe the earlier upload.
      const source = { ...declared, manifestHash: hash(manifest), weightsHash: hash(weights) };
      Harness.network.routes = releaseRoutes("Mappsnet7/DLSSMac", "v0.1.6", declared.fileName, bytes);
      const model = await Setup.downloadDlssMac({ userDataDir, confirmRuntimeInstall: async () => true }, { source });
      assert.ok(Models.validVersion(model.version));
      const receipt = JSON.parse(fs.readFileSync(path.join(model.installDir, "download-source.json")));
      assert.deepEqual([receipt.bytes, receipt.sha256], [bytes.length, hash(bytes)]);
    }
  }
};
