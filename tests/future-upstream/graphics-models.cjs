const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { githubRelease, githubRoutes } = require("../helpers/future-upstream.cjs");

// Model and tool downloads outside runtime catalogs: SteamCMD's bootstrap
// behind a fixed Valve URL, and model archives published as GitHub release
// assets that the publisher may replace. Revision-pinned model files (raw
// GitHub and Hugging Face URLs naming a commit) are immutable; every model
// file keeps its identity checksum.
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function temporary(t, prefix) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}
// A minimal arm64 Mach-O executable header stands in for Valve's steamcmd.
function machO() {
  const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(2, 12); return bytes;
}
// A GitHub release whose one asset has the given bytes and published digest.
function releaseRoutes(repository, tag, name, bytes) {
  const release = githubRelease(repository, tag, [name]);
  release.assets[0] = { ...release.assets[0], size: bytes.length, digest: "sha256:" + hash(bytes) };
  return { ...githubRoutes(repository, [release]), [release.assets[0].browser_download_url]: bytes };
}

module.exports = {
  checks: {
    "a replaced SteamCMD bootstrap signed by Valve's Developer ID is accepted in a new format and folder": async (t, Harness) => {
      const Steam = require("../../src/modules/shared/reshade/steam-models");
      const root = temporary(t, "future-steamcmd-");
      for (const [name, folder, flags] of [["replaced.tar.gz", "", "-czf"], ["nested.tar.xz", "steamcmd_osx", "-cJf"]]) {
        const source = path.join(root, name + "-source"), tools = path.join(source, folder);
        fs.mkdirSync(tools, { recursive: true });
        fs.writeFileSync(path.join(tools, "steamcmd"), Buffer.concat([machO(), Buffer.from(name)]), { mode: 0o755 });
        fs.writeFileSync(path.join(tools, "steamcmd.sh"), "#!/bin/sh\n");
        execFileSync("/usr/bin/tar", [flags, path.join(root, name), "-C", source, "."]);
        const userDataDir = path.join(root, name + "-profile"), calls = [];
        Harness.network.routes = { [Steam.BOOTSTRAP.location]: fs.readFileSync(path.join(root, name)) };
        const result = await Steam.acquire({ userDataDir }, {
          execute: async (command, args, options) => {
            calls.push([command, ...args]);
            // The archive is extracted for real; codesign reports Valve's signature.
            if (command === "/usr/bin/tar") return require("node:util").promisify(require("node:child_process").execFile)(command, args, options);
            assert.equal(command, "/usr/bin/codesign"); return { stdout: "", stderr: "" };
          },
          authenticate: async session => {
            assert.match(calls.find(call => call[0] === "/usr/bin/codesign").at(-1), new RegExp(`${session.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/tools/steamcmd$`));
            assert.equal(fs.readFileSync(path.join(session, "tools", "steamcmd")).subarray(64).toString(), name, "the downloaded bootstrap runs");
            fs.writeFileSync(path.join(session, "content", "Lossless.dll"), "dll");
          }, importModel: async () => ({ version: "3.2.2.0" }) });
        assert.equal(result.version, "3.2.2.0", name);
      }
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
