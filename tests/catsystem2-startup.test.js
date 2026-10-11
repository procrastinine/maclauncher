const test = require("node:test"), assert = require("node:assert/strict");
const Startup = require("../src/modules/catsystem2/startup");
const settings = value => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><document><VERSION><ini>20</ini></VERSION><SCREEN><width>800</width><height>600</height><fps>60</fps></SCREEN><SCRIPT><start>${value || "kernel.int/entry.kcs"}</start></SCRIPT><language><default>0</default><L00><prefix>en</prefix></L00></language></document>`);
test("CatSystem2 authored startup selects the program, canvas and language with no game-specific defaults", () => {
  const before = settings(), result = Startup.parseStartup(before);
  assert.deepEqual(result.canvas, { width: 800, height: 600 }); assert.equal(result.start, "kernel.int/entry.kcs"); assert.equal(result.fps, 60); assert.equal(result.language, "en"); assert.deepEqual(before, settings());
});
test("CatSystem2 XML rejects DTDs, entities, ambiguous settings, malformed and oversized structures", () => {
  for (const text of ["<!DOCTYPE document SYSTEM 'file:///etc/passwd'><document/>", "<document><x>&secret;</x></document>", "<document><x></document>",
    "<document><x>&#xD800;</x></document>", "<document/><document/>", "<document><x a='b' a='c'/></document>"]) assert.throws(() => Startup.parseXml(Buffer.from(text)), /CatSystem2/);
  assert.equal(Startup.parseXml(Buffer.from('<document><item voice="A &amp; B"/></document>')).children[0].attributes.voice, "A & B");
  for (const text of [settings("../entry.kcs"), settings().toString().replace("<ini>20", "<ini>21"), settings().toString().replace("<width>800</width>", "<width>800</width><width>900</width>"),
    settings().toString().replace("<width>800", "<width>16384").replace("<height>600", "<height>16384")]) assert.throws(() => Startup.parseStartup(Buffer.from(text)), /CatSystem2/);
});
