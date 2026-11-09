// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Library = require("../src/modules/shared/reshade/xess/library");

// Intel's files are read from the repository at the XeSS SDK revision the
// installed graphics package records; a different file installs nothing.
test("XeSS downloads read the installed graphics package's SDK revision and keep nothing that is not Intel's declared file", async t => {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xess-download-")));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xess-graphics-"))), revision = "f".repeat(40);
  t.after(() => { Harness.network.routes = null; fs.rmSync(userDataDir, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ sourcePins: [`${revision} third_party/xess-original`, `${revision} third_party/xess`] }));
  assert.equal(Library.release(root).revision, revision);
  const requests = [], url = file => `https://raw.githubusercontent.com/intel/xess/${revision}/bin/${file}`;
  Harness.network.routes = Object.fromEntries([Library.Source.file, ...Library.Components.files.map(spec => spec.file)].map(file =>
    [url(file), () => { requests.push(url(file)); return Buffer.from("not the declared library"); }]));
  const approved = { userDataDir, root, confirmRuntimeInstall: async () => true };
  await assert.rejects(Library.install(approved), /is not the declared Intel XeSS file: its size or checksum differs/);
  await assert.rejects(Library.install({ ...approved, operation: "interpolate" }), /is not the declared Intel XeSS file: its size or checksum differs/);
  assert.equal(requests[0], url(Library.Source.file));
  assert.ok(requests.every(value => value.includes(`/intel/xess/${revision}/`)));
  const installDir = Library.directory(userDataDir);
  assert.deepEqual(fs.existsSync(installDir) ? fs.readdirSync(installDir) : [], [], "no downloaded or partial file remains");
  assert.deepEqual(Library.listInstalled(userDataDir), []);
});
