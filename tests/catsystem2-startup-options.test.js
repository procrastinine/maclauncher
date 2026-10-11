const test = require("node:test"), assert = require("node:assert/strict");
const { parseXml } = require("../src/modules/catsystem2/startup");
const { parseStartupOptions } = require("../src/modules/catsystem2/runtime/startup-options");
const parse = body => parseStartupOptions({ engineVersion: "2.6.1.76", document: parseXml(Buffer.from("<document>" + body + "</document>")) });
test("native startup getters use authored values and established absent defaults", () => {
  assert.equal(parse("").get(999), 0); assert.equal(parse("<GAME><autoselect>1</autoselect></GAME>").get(999), 1);
  assert.equal(parse("<GAME><autoselect>-2147483648</autoselect></GAME>").get(999), -2147483648);
  assert.throws(() => parse("").get(998), /option is unsupported/);
});
test("native startup options reject malformed XML values and incompatible profiles", () => {
  for (const value of ["", "0x1", "Infinity", "1.5", "2147483648"]) assert.throws(() => parse("<GAME><autoselect>" + value + "</autoselect></GAME>"), /range/);
  assert.throws(() => parse("<GAME><autoselect>0</autoselect><autoselect>0</autoselect></GAME>"), /ambiguous/);
  assert.throws(() => parseStartupOptions({ engineVersion: "2.6.1.77", document: parseXml(Buffer.from("<document/>")) }), /version/);
});
