// Required first: it replaces the network functions before modules load.
const Harness = require("./helpers/future-upstream.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Library = require("../src/modules/shared/reshade/xess/library");

// Intel's files are read from the repository at the exact commit the SDK
// declaration names; a different file installs nothing.
test("XeSS downloads read the declared commit and keep nothing that is not Intel's declared file", async t => {
  const userDataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xess-download-")));
  t.after(() => { Harness.network.routes = null; fs.rmSync(userDataDir, { recursive: true, force: true }); });
  const requests = [];
  Harness.network.routes = Object.fromEntries([Library.Source.url, ...Library.Components.files.map(spec =>
    `https://raw.githubusercontent.com/intel/xess/${Library.Components.revision}/bin/${spec.file}`)].map(url => [url, () => { requests.push(url); return Buffer.from("not the declared library"); }]));
  const approved = { userDataDir, confirmRuntimeInstall: async () => true };
  await assert.rejects(Library.install(approved), /is not the declared Intel XeSS file: its size or checksum differs/);
  await assert.rejects(Library.install({ ...approved, operation: "interpolate" }), /is not the declared Intel XeSS file: its size or checksum differs/);
  assert.equal(requests[0], Library.Source.url);
  assert.ok(requests.every(url => url.includes(`/intel/xess/${Library.Source.revision}/`) || url.includes(`/intel/xess/${Library.Components.revision}/`)));
  const root = Library.directory(userDataDir);
  assert.deepEqual(fs.existsSync(root) ? fs.readdirSync(root) : [], [], "no downloaded or partial file remains");
  assert.deepEqual(Library.listInstalled(userDataDir), []);
});
