const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { userImportError } = require("../src/core/import-error");
const { createGameImportQueue } = require("../src/core/game-import-queue");
const Inputs = require("../src/modules/shared/installers");

test("import errors name the item and retain diagnostic details outside the displayed message", async () => {
  const original = Object.assign(new Error("No index.html at /private/internal/root"), {
    name: "DetectionError", code: "DETECTION_UNSUPPORTED", detection: { trace: ["original evidence"] }
  });
  const queue = createGameImportQueue();
  queue.setImporter(() => { throw original; });
  await assert.rejects(queue.import("/private/internal/notes.txt"), error => {
    assert.match(error.message, /“notes.txt”.*TXT file.*main game file or complete folder/);
    assert.doesNotMatch(error.message, /DetectionError|index\.html|\/private/);
    assert.equal(error.code, original.code);
    assert.equal(error.detection, original.detection);
    assert.equal(error.cause, original);
    assert.match(error.stack, /No index.html at \/private\/internal\/root/);
    return true;
  });
});

test("conflicts, access failures and unknown errors offer a next step without disclosing internals", () => {
  for (const [code, expected] of [["DETECTION_CONFLICT", /more than one possible game/],
    ["DETECTION_NOT_FOUND", /Locate the file or folder/], ["DETECTION_LIMIT", /more specific folder/],
    ["EACCES", /permissions in Finder/], ["EPERM", /permissions in Finder/], ["OTHER", /complete and readable/]]) {
    const error = userImportError(Object.assign(new Error("internal /Users/test/private"), { code }), "/games/My Game.exe");
    assert.match(error.message, /“My Game.exe”/);
    assert.match(error.message, expected);
    assert.doesNotMatch(error.message, /\/Users|internal/);
  }
  assert.match(userImportError({ code: "DETECTION_UNSUPPORTED_EXTENSION" }, "C:\\Games\\sample.xyz").message, /“sample.xyz”.*XYZ file/);
});

test("unsupported folders and Mac applications use their input kind", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "import-message-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Example.app"); fs.mkdirSync(app);
  assert.match(userImportError({ code: "DETECTION_UNSUPPORTED" }, root).message, /a folder/);
  assert.match(userImportError({ code: "DETECTION_UNSUPPORTED" }, app).message, /Mac application/);
});

test("installer errors describe the reader or required input, and cancellation keeps its identity", () => {
  for (const [code, expected] of [["INSTALLER_READER_FAILED", /Runtimes → Tools → Installer reader/],
    ["INSTALLER_TOOL_MISSING", /choose or install a reader version/], ["INSTALLER_MISSING_PARTS", /companion data files beside/],
    ["INSTALLER_ENCRYPTED", /unencrypted offline installer/], ["INSTALLER_INVALID", /complete offline installer/]]) {
    const error = userImportError({ code, message: "This version does not identify its source revision." }, "/games/setup_example.exe");
    assert.match(error.message, /“setup_example.exe” is an installer/);
    assert.match(error.message, expected);
    assert.doesNotMatch(error.message, /source revision/);
  }
  for (const abort of [{ code: "ABORT_ERR" }, { name: "AbortError" }]) assert.equal(userImportError(abort, "/game"), abort);
});

test("the installer provider tags reader preparation failures while preserving known installer and abort errors", async t => {
  const provider = Inputs.providers[0], prepare = provider.prepare, probe = provider.probe;
  t.after(() => { provider.prepare = prepare; provider.probe = probe; });
  provider.probe = () => ({ format: "inno" });
  const source = new Error("This version does not identify its source revision.");
  provider.prepare = async () => { throw source; };
  await assert.rejects(Inputs.prepareInput("setup.exe", {}), error => {
    assert.equal(error.code, "INSTALLER_READER_FAILED");
    assert.equal(error.cause, source);
    return true;
  });
  for (const code of ["ABORT_ERR", "INSTALLER_MISSING_PARTS"]) {
    const error = Object.assign(new Error("original"), { code });
    provider.prepare = async () => { throw error; };
    await assert.rejects(Inputs.prepareInput("setup.exe", {}), caught => caught === error);
  }
});
