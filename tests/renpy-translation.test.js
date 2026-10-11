const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureTranslation } = require("../src/modules/renpy/runtime/translation");
const { createRosettaService, RUNTIME_PATH } = require("../src/modules/shared/runtime/rosetta");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-renpy-translation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "lib", "py2-mac-universal");
  fs.mkdirSync(dir, { recursive: true });
  return { dir, platform: "mac-universal" };
}
function binary(file, arch) {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  header.writeUInt32LE(2, 12); fs.writeFileSync(file, header, { mode: 0o755 });
}
function missingRosetta() {
  return createRosettaService({ platform: "darwin", arch: "arm64",
    fileSystem: { ...fs, statSync: file => { if (file === RUNTIME_PATH) throw new Error("missing"); return fs.statSync(file); } },
    spawnSync: () => ({ status: 1 }), runInstaller: () => assert.fail("installer without accepted consent") });
}

test("an Intel Python hidden in mac-universal requests Rosetta before a shell launch", async t => {
  const lib = fixture(t); binary(path.join(lib.dir, "renpy"), "x86_64"); let prompts = 0;
  await assert.rejects(ensureTranslation(lib, { confirmRuntimeInstall: plan => {
    prompts++; assert.equal(plan.prerequisiteId, "rosetta"); assert.equal(plan.licenseRequired, true); return false;
  } }, "renpy", missingRosetta()), { name: "AbortError" });
  assert.equal(prompts, 1);
});

test("an arm64 Python needs no prerequisite check or download consent", async t => {
  const lib = fixture(t); binary(path.join(lib.dir, "renpy"), "arm64");
  assert.equal(await ensureTranslation(lib, { confirmRuntimeInstall: () => assert.fail("arm64 consent") }, "renpy", missingRosetta()), null);
});

test("patched launch inspects its named binary and falls back to renpy only when absent", async t => {
  const lib = fixture(t); binary(path.join(lib.dir, "renpy"), "arm64"); binary(path.join(lib.dir, "game"), "x86_64");
  let prompts = 0;
  const context = { confirmRuntimeInstall: () => { prompts++; return false; } };
  await assert.rejects(ensureTranslation(lib, context, "game", missingRosetta()), { name: "AbortError" });
  fs.unlinkSync(path.join(lib.dir, "game"));
  assert.equal(await ensureTranslation(lib, context, "game", missingRosetta()), null);
  assert.equal(prompts, 1);
});

test("missing SDK executables fail before an unrelated prerequisite install", async t => {
  const lib = fixture(t);
  await assert.rejects(ensureTranslation(lib, { confirmRuntimeInstall: () => assert.fail("missing executable consent") }, "renpy", missingRosetta()), /executable is missing/);
  await assert.rejects(ensureTranslation(null), /libraries are missing/);
});
