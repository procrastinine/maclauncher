const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const Ticket = require("../src/modules/shared/runtime/steamworks/ticket");

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "steam-ticket-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = "ticket-unavailable-fixture-1", directory = path.join(root, "native-runtimes", Ticket.ID, version, "universal");
  fs.mkdirSync(directory, { recursive: true });
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(6, 12);
  const library = path.join(directory, Ticket.FILENAME);
  fs.writeFileSync(library, bytes, { mode: 0o644 });
  const pin = { schemaVersion: 1, id: Ticket.ID, version, sourceKind: "owned", sourceSha256: "a".repeat(64), sourceRevision: null,
    librarySha256: hash(bytes), architectures: ["arm64"], minimumMacOS: "13.0", policy: "unavailable" };
  const manifest = { schemaVersion: 1, ...pin, files: [{ path: Ticket.FILENAME, size: bytes.length, mode: 0o644,
    sha256: hash(bytes), architectures: ["arm64"] }] };
  const seal = () => { const content = JSON.stringify(manifest); fs.writeFileSync(path.join(directory, "helper.json"), content); pin.manifestSha256 = hash(content); };
  seal();
  return { root, directory, library, pin, manifest, seal,
    options: { resourcesRoot: root, architecture: "arm64", version, catalog: [pin] } };
}

test("included encrypted-ticket loader carries its exact unavailable policy and owned source identity", t => {
  const f = fixture(t), result = Ticket.resolveBundledTicket(f.options);
  assert.equal(result.ready, true); assert.equal(result.libraryPath, f.library);
  assert.equal(result.policy, "unavailable"); assert.equal(result.sourceKind, "owned");
  assert.equal(result.sourceSha256, f.pin.sourceSha256); assert.equal(result.sourceRevision, null);
  assert.equal(result.minimumMacOS, "13.0"); assert.equal(result.readOnly, true);
  assert.equal(result.installDir, undefined);
});

test("ticket lookup rejects missing versions, CPUs, unsafe package paths and non-owned policies", t => {
  const f = fixture(t);
  assert.equal(Ticket.resolveBundledTicket({ ...f.options, version: "other" }).ready, false);
  assert.equal(Ticket.resolveBundledTicket({ ...f.options, architecture: "x86_64" }).ready, false);
  assert.equal(Ticket.resolveBundledTicket({ ...f.options, architecture: "unknown" }).ready, false);
  for (const changes of [{ packageVersion: "../outside" }, { id: "steam-api-helper" }, { schemaVersion: 2 },
    { sourceKind: "git", sourceSha256: null, sourceRevision: "a".repeat(40) },
    { policy: "decrypt" }, { sourceRevision: "b".repeat(40) }]) {
    assert.equal(Ticket.resolveBundledTicket({ ...f.options, catalog: [{ ...f.pin, ...changes }] }).ready, false);
  }
});

test("ticket manifest source, native bytes, version, floor and policy remain bound to the catalog", t => {
  const f = fixture(t), original = { ...f.manifest };
  for (const changes of [{ sourceSha256: "b".repeat(64) }, { librarySha256: "b".repeat(64) },
    { version: "other" }, { architectures: ["x86_64"] }, { minimumMacOS: "27.0" }, { policy: "decrypt" }, { id: "steam-api-helper" }]) {
    Object.assign(f.manifest, original, changes); f.seal();
    assert.equal(Ticket.resolveBundledTicket(f.options).ready, false);
  }
  Object.assign(f.manifest, original); f.seal();
  fs.appendFileSync(path.join(f.directory, "helper.json"), " ");
  assert.match(Ticket.resolveBundledTicket(f.options).reason, /manifest changed/);
});

test("ticket library payload rejects changed bytes, symlinks and added native inputs", t => {
  const f = fixture(t), bytes = fs.readFileSync(f.library);
  fs.writeFileSync(f.library, Buffer.alloc(bytes.length));
  assert.equal(Ticket.resolveBundledTicket(f.options).ready, false);
  fs.writeFileSync(f.library, bytes);
  fs.writeFileSync(path.join(f.directory, "extra.dylib"), "unexpected");
  assert.equal(Ticket.resolveBundledTicket(f.options).ready, false);
  fs.unlinkSync(path.join(f.directory, "extra.dylib"));
  fs.renameSync(f.library, path.join(f.root, "library"));
  fs.symlinkSync(path.join(f.root, "library"), f.library);
  assert.equal(Ticket.resolveBundledTicket(f.options).ready, false);
});
