const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const Tools = require("../src/modules/hashlink/tools");
function fixture(t, version = 4) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hashlink-tools-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "game.hl"), header = [72, 76, 66, version, 0, 0, 0, 0];
  if (version >= 5) header.push(0); header.push(2, 0, 0, 1, 0, 0);
  fs.writeFileSync(source, Buffer.concat([Buffer.from(header), Buffer.alloc(version >= 5 ? 8 : 4), Buffer.from([0, 10, 0, 0])]));
  return { source, entry: { gameId: "bytecode-tools", moduleData: { bytecodePath: source } }, context: { userDataDir: path.join(root, "profile"), settings: {} } };
}
test("hlbc's version boundary is checked before tool acquisition", async t => {
  const { entry, context } = fixture(t, 6); let downloaded = false;
  await assert.rejects(Tools.exportBytecode(entry, {}, context, { manager: { ensure: async () => { downloaded = true; } } }), /versions 4 and 5/);
  assert.equal(downloaded, false);
});
test("upstream disassembler and decompiler failures retain useful metadata with explicit warnings", async t => {
  const { source, entry, context } = fixture(t); const before = fs.readFileSync(source);
  const manager = { ensure: async () => ({ version: "0.5.0" }), run: async (_entry, _context, options) => {
    const command = options.args.at(-1);
    if (command.includes("fnh ..")) fs.writeFileSync(options.stdoutPath, "metadata and headers");
    else { fs.writeFileSync(options.stdoutPath, "partial output"); throw Object.assign(Error("upstream panic"), { exitCode: 101 }); }
    return {};
  } };
  const result = await Tools.exportBytecode(entry, {}, context, { manager });
  assert.match(result.disassemblyWarning, /incomplete/); assert.match(result.decompileWarning, /could not/);
  assert.equal(fs.readFileSync(path.join(result.outputRoot, "metadata.txt"), "utf8"), "metadata and headers");
  assert.equal(fs.readFileSync(path.join(result.outputRoot, "bytecode.txt"), "utf8"), "partial output");
  assert.deepEqual(fs.readFileSync(source), before);
});
