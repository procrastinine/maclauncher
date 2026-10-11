const test = require("node:test"), assert = require("node:assert/strict");
const { parseFrontEnd, tokens } = require("../src/modules/catsystem2/frontend-parser");
test("FES concatenates authored blocks and expands whole-word numeric macros in expressions", () => {
  const program = parseFrontEnd('#MACRO\nCOUNT 4\n#DEFINE\nBUTTON buttons[2]\n#OBJECT DISP ENABLE\nbuttons 1 0\n#START\n\\COUNT = 1\n#WAIT\nwait 1\n#START\n\\(COUNT+1) = COUNT+2\nnext WAIT\n#WAIT\nif(\\COUNT2) break\n');
  assert.equal(program.blocks.size, 2); assert.equal(program.blocks.get("START").statements.length, 3);
  assert.equal(program.blocks.get("START").statements[0].source, "\\4 = 1"); assert.equal(program.blocks.get("START").statements[1].source, "\\(4+1) = 4+2");
  assert.equal(program.blocks.get("WAIT").statements[1].source, "if(\\COUNT2) break"); assert.equal(program.objects.get("buttons[1]").attributes.get("ENABLE"), "0");
});
test("FES rejects escaping object counts, undefined initialization targets and malformed sections", () => {
  for (const source of ["#DEFINE\nBUTTON buttons[4097]\n#START", "#OBJECT DISP\nmissing 1\n#START", '#START\ncall "unterminated', "#MACRO\nCOUNT 1\nCOUNT 2\n#START"])
    assert.throws(() => parseFrontEnd(source), /FES/);
});
test("FES separates ASCII controls while preserving authored non-ASCII glyph parameters", () => {
  assert.deepEqual(tokens("\ttext layout\tprof 0 \u3000 // glyph"), ["text", "layout", "prof", "0", "\u3000"]);
  const program = parseFrontEnd("#START\n\ttext layout prof 0 \u3000\t");
  const statement = program.blocks.get("START").statements[0];
  assert.equal(statement.source, "text layout prof 0 \u3000"); assert.equal(statement.words.at(-1), "\u3000");
  assert.deepEqual(tokens('text str "first\tsecond\u3000"'), ["text", "str", '"first\tsecond\u3000"']);
});
