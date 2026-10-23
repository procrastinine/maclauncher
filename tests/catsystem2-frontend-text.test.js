const test = require("node:test"), assert = require("node:assert/strict");
const { createFrontEndText } = require("../src/modules/catsystem2/runtime/frontend-text");
const { parseFrontEnd } = require("../src/modules/catsystem2/frontend-parser"), { FrontEndMachine } = require("../src/modules/catsystem2/runtime/frontend-vm");
function components(extra = {}) {
  const font = Buffer.alloc(32, 17), reads = [], verifications = [], calls = [], machine = new FrontEndMachine(parseFrontEnd("#START"), { globals: new Int32Array(32) });
  const registry = { locate: async (type, name) => { assert.equal(type, "font"); return { sourcePath: `font/${name}`, observation: { path: `/original/font/${name}`, identity: "immutable:1" } }; },
    read: async (type, name) => { reads.push([type, name]); return font; }, verify: async located => { verifications.push(located.sourcePath); } };
  const text = createFrontEndText({ engineVersion: "2.6.1.76", registry, cache: { get: async (bytes, request) => { assert.equal(bytes, font); calls.push(request);
    return { rgbaPath: "/cache/text.rgba", rgba: Buffer.alloc(request.width * request.height * 4), width: request.width, height: request.height, endX: 42.75, endY: 20.5 }; } }, ...extra });
  const object = { type: "STRING8", textContent: "", width: 60, height: 30 }; return { text, object, font, reads, verifications, calls, machine };
}
async function layout({ text, object, machine }) {
  for (const args of [["size", "16"], ["frame", "0"], ["shadow", "0"], ["fontind", "1", "authored.ttf"], ["margin", "1", "2", "3", "4"], ["move", "2", "5"],
    ["color", "12", "23", "34", "0", "0", "0", "255", "255", "255"]]) await text.command(object, "layout", args, machine);
}
test("STRING8 draws with explicit authored fonts/layout and writes actual metrics only to selected flags", async () => {
  const values = components(), before = Buffer.from(values.font); await layout(values);
  await values.text.command(values.object, "str", ['"Menu"'], values.machine); const frame = await values.text.frame(values.object);
  assert.equal(frame.rgbaPath, "/cache/text.rgba"); assert.deepEqual(values.calls[0], { width: 60, height: 30, fontSize: 16, margin: [1,2,3,4], color: [12,23,34],
    letterSpacing: 2, lineSpacing: 5, shadow: "none", alignment: "left", text: "Menu" });
  values.machine.globals[0] = 9; await values.text.command(values.object, "endpos", ["-1", "7"], values.machine);
  assert.equal(values.machine.globals[0], 9); assert.equal(values.machine.globals[7], 20); assert.deepEqual(values.reads, [["font", "authored.ttf"]]);
  assert.ok(values.verifications.length >= 3); assert.deepEqual(values.font, before);
});
test("empty STRING8 content needs no font/pixels; reset preserves text while clear removes it", async () => {
  const values = components(); assert.equal(await values.text.frame(values.object), null);
  await values.text.command(values.object, "endpos", ["2", "3"], values.machine); assert.equal(values.machine.globals[2], 0); assert.equal(values.machine.globals[3], 0); assert.deepEqual(values.reads, []);
  await layout(values); await values.text.command(values.object, "str", ['"A"'], values.machine); await values.text.command(values.object, "apend", ['"B"'], values.machine);
  await values.text.command(values.object, "reset", [], values.machine); assert.equal(values.object.textContent, "AB");
  await assert.rejects(values.text.frame(values.object), /animation is unsupported/);
  await values.text.command(values.object, "clear", [], values.machine); assert.equal(await values.text.frame(values.object), null); assert.deepEqual(values.reads, []);
});
test("unsupported text modes, escapes, shadow effects and unbound font-size choices fail explicitly", async () => {
  const values = components();
  for (const [name, args] of [["unknown", []], ["layout", ["ruby", "1"]], ["layout", ["shadow", "1"]], ["layout", ["fontind", "0", "authored.ttf"]],
    ["layout", ["fontind", "1", "../escape.ttf"]], ["str", ['"bad\\w0;"']], ["endpos", ["0", "32"]], ["layout", ["margin", "1"]]])
    assert.throws(() => values.text.validateCommand(name, args, values.machine), /unsupported|range|path/i);
  await layout(values); await values.text.command(values.object, "layout", ["size", "10", "12", "14", "16", "18"], values.machine);
  await values.text.command(values.object, "str", ['"Text"'], values.machine); await assert.rejects(values.text.frame(values.object), /preference selection is unavailable/);
  assert.equal(values.calls.length, 0);
});
test("text font reads coalesce across simultaneous independent objects and retain per-object layouts", async () => {
  const values = components(), other = { ...values.object }; await layout(values); await layout({ ...values, object: other });
  await values.text.command(values.object, "str", ['"First"'], values.machine); await values.text.command(other, "str", ['"Second"'], values.machine);
  await Promise.all([values.text.frame(values.object), values.text.frame(other)]); assert.equal(values.reads.length, 1); assert.deepEqual(values.calls.map(value => value.text).sort(), ["First", "Second"]);
  assert.equal(values.object.textContent, "First"); assert.equal(other.textContent, "Second"); values.text.close();
});
test("the bounded legacy vdraw option leaves text pixels and metrics unchanged; unknown modes remain errors", async () => {
  const values = components(); await layout(values); await values.text.command(values.object,"str",['"Static"'],values.machine);
  await values.text.frame(values.object); const before = values.calls[0];
  await values.text.command(values.object,"layout",["vdraw","1"],values.machine); await values.text.frame(values.object);
  assert.deepEqual(values.calls[1],before); assert.equal(values.object.textContent,"Static");
  for (const supplied of [["vdraw","2"],["vdraw","1","0"],["unknown","1"],["vdraw_future","1"]])
    assert.throws(() => values.text.validateCommand("layout",supplied,values.machine),/range|unsupported/i);
  await values.text.command(values.object,"layout",["rsize","9"],values.machine); await values.text.command(values.object,"layout",["ruby","0"],values.machine);
  await values.text.frame(values.object); assert.deepEqual(values.calls[2],before);
});
test("known STRING8 property setters retain their effect and cannot silently use the limited renderer", async () => {
  const values = components(); await layout(values);
  await values.text.command(values.object,"layout",["indent","1"],values.machine);
  assert.equal(await values.text.frame(values.object),null);
  await values.text.command(values.object,"str",['"Visible"'],values.machine);
  await assert.rejects(values.text.frame(values.object),/indentation or proportional/);
  await values.text.command(values.object,"layout",["indent","0"],values.machine);
  await values.text.command(values.object,"layout",["fontfix","0"],values.machine);
  await values.text.frame(values.object); assert.equal(values.calls.length,1);
  for (const arguments_ of [["fontfix","1"],["profmode","0"],["prof_enable","1"],["c_prof","2"],["prof","0",'"　"']]) {
    await values.text.command(values.object,"reset",[],values.machine); await layout(values);
    await values.text.command(values.object,"layout",arguments_,values.machine);
    await assert.rejects(values.text.frame(values.object),/indentation or proportional/);
  }
  for (const arguments_ of [["indent","2"],["fontfix","-1"],["profmode","3"],["c_prof","4"],["prof","0"],["prof","0",'"bad\\escape"']])
    assert.throws(()=>values.text.validateCommand("layout",arguments_,values.machine),/range|unsupported/i);
  assert.equal(values.calls.length,1);
});
