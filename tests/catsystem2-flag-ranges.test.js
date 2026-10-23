const test = require("node:test"), assert = require("node:assert/strict");
const { parseXml } = require("../src/modules/catsystem2/startup");
const { parseFlagRanges } = require("../src/modules/catsystem2/runtime/flag-ranges");
const parse = body => parseFlagRanges({ engineVersion: "2.6.1.76", flagCount: 2048,
  document: parseXml(Buffer.from("<document><GAME><flag>" + body + "</flag></GAME></document>")) });
test("authored flag banks preserve defaults, explicit extents and the nonzero global selector", () => {
  const ranges = parse("<local1><start>1024</start><count>1024</count></local1><global0><start>700</start></global0>");
  assert.deepEqual(ranges.range(0, 0), { start: 0, count: 512 });
  assert.deepEqual(ranges.range(0, 1), { start: 1024, count: 1024 });
  assert.deepEqual(ranges.range(1, 0), { start: 700, count: 512 }); assert.deepEqual(ranges.range(0xffffffff, 0), ranges.range(1, 0));
  assert.deepEqual(ranges.range(1, 7), { start: -1, count: -1 }); assert.throws(() => ranges.range(0, 8), /selector/);
  assert.throws(() => ranges.range(0, -1), /selector/);
});
test("invalid flag banks reject unsafe ranges, duplicate definitions and unknown versions", () => {
  for (const text of ["<local0><start>2000</start><count>100</count></local0>", "<global1><start>-2</start></global1>",
    "<local1><count>2049</count></local1>", "<local0/><local0/>"])
    assert.throws(() => parse(text), /range|ambiguous/);
  assert.throws(() => parseFlagRanges({ engineVersion: "4.1", flagCount: 2048 }), /version/);
  assert.throws(() => parseFlagRanges({ engineVersion: "2.6.1.76", flagCount: 2048, document: parseXml(Buffer.from("<document/>")) }), /startup settings/);
});
