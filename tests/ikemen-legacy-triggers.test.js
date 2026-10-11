const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { rewriteVersionComparisons, prepareLegacyTriggers } = require("../src/modules/ikemen/legacy-triggers");

test("Ikemen converts only exact legacy version-boundary expressions, preserving comments, strings and other comparisons", () => {
  const input = 'if mugenVersion < 1.0 {\r\n if MugenVersion >= 1.0;\r\n}\r\n# mugenVersion < 1.0\n/* mugenVersion >= 1.0 */\n"mugenVersion < 1.0"\nif mugenVersion < 1.1\nif mugenVersion(major) < 1\nif myMugenVersion < 1.0\n';
  const output = rewriteVersionComparisons(input);
  assert.equal(output.replacements, 2);
  assert.equal(output.text, input.replace('mugenVersion < 1.0 {','mugenVersion(major) < 1 {').replace('MugenVersion >= 1.0;','mugenVersion(major) >= 1;'));
  assert.deepEqual(rewriteVersionComparisons('; mugenVersion < 1.0\ntrigger1 = mugenVersion >= 1.0', { zss: false }),
    { text: '; mugenVersion < 1.0\ntrigger1 = mugenVersion(major) >= 1', replacements: 1 });
});

test("Ikemen transforms only private script aliases for the reviewed runner and retains player files", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ikemen-legacy-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "original.zss"), wrapper = path.join(root, "managed"), script = path.join(wrapper, "data/common.zss");
  const original = Buffer.concat([Buffer.from('if mugenVersion < 1.0 {} # '), Buffer.from([0x82, 0xa0, 0xff])]);
  fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(source, original); fs.symlinkSync(source, script);
  fs.writeFileSync(path.join(wrapper, "player-save.json"), "player state");
  const reviewed = { version: "1.0.0", upstreamRevision: "81c6da71d689625e20db79586815b695da00dd6d" };
  assert.deepEqual(prepareLegacyTriggers(wrapper, { ...reviewed, version: "0.99.0" }), []);
  const changes = prepareLegacyTriggers(wrapper, reviewed);
  assert.equal(changes.length, 1); assert.equal(changes[0].replacements, 1);
  assert.equal(fs.lstatSync(script).isFile(), true);
  assert.deepEqual(fs.readFileSync(script), Buffer.concat([Buffer.from('if mugenVersion(major) < 1 {} # '), Buffer.from([0x82, 0xa0, 0xff])]));
  assert.deepEqual(fs.readFileSync(source), original);
  assert.deepEqual(prepareLegacyTriggers(wrapper, reviewed), []);
  assert.equal(fs.readFileSync(path.join(wrapper, "player-save.json"), "utf8"), "player state");
});
