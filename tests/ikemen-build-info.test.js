const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { parseInlineBuildInfo, readGoBuildInfo, MAX_DATA_BYTES } = require("../src/modules/ikemen/go-build-info");

function field(text) {
  const data = Buffer.from(text), length = []; let value = data.length;
  do { length.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128); } while (value);
  return Buffer.concat([Buffer.from(length), data]);
}
function buildInfo(module = "github.com/ikemen-engine/Ikemen-GO", version = "(devel)") {
  const header = Buffer.alloc(32); Buffer.from("\xff Go buildinf:", "latin1").copy(header); header[14] = 8; header[15] = 2;
  const text = "0".repeat(16) + `\npath\t${module}\nmod\t${module}\t${version}\n` +
    "build\tGOOS=windows\nbuild\tGOARCH=amd64\nbuild\tvcs.revision=" + "a".repeat(40) + "\nbuild\tvcs.modified=true\nbuild\tvcs.time=2025-11-26T22:07:16Z\n" + "1".repeat(16);
  return Buffer.concat([header, field("go1.20.14 X:arenas"), field(text)]);
}

test("Ikemen build metadata preserves source revision without inventing release versions for development binaries", () => {
  const info = parseInlineBuildInfo(buildInfo());
  assert.equal(info.version, null); assert.equal(info.revision, "a".repeat(40)); assert.equal(info.modified, true);
  assert.equal(info.platform, "windows"); assert.equal(info.architecture, "amd64");
  assert.equal(info.timestamp, "2025-11-26T22:07:16Z");
  assert.equal(parseInlineBuildInfo(buildInfo("github.com/other/app")), null);
  assert.equal(parseInlineBuildInfo(buildInfo("github.com/ikemen-engine/Ikemen-GO", "v1.0.0")).version, "1.0.0");
  const old = buildInfo(); old[15] = 0; assert.equal(parseInlineBuildInfo(old), null);
});

test("Ikemen reads only bounded PE data sections and treats malformed metadata as unknown", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ikemen-build-info-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "game.exe"), header = Buffer.alloc(256), data = buildInfo();
  header.write("MZ"); header.writeUInt32LE(64, 0x3c); header.writeUInt32LE(0x4550, 64); header.writeUInt16LE(1, 70);
  header.write(".data", 88); header.writeUInt32LE(data.length, 104); header.writeUInt32LE(256, 108);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  const info = readGoBuildInfo(file); assert.equal(info.filePath, file); assert.equal(info.revision, "a".repeat(40)); assert.ok(info.inspectedBytes <= MAX_DATA_BYTES);
  header.writeUInt32LE(0xffffffff, 108); fs.writeFileSync(file, Buffer.concat([header, data])); assert.equal(readGoBuildInfo(file), null);
  fs.writeFileSync(file, "not an executable"); assert.equal(readGoBuildInfo(file), null);
  assert.equal(readGoBuildInfo(path.join(root, "missing.exe")), null);
});
