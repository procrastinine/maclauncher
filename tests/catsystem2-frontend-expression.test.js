const test = require("node:test"), assert = require("node:assert/strict");
const { expression, parseExpression } = require("../src/modules/catsystem2/frontend-expression");
const state = () => ({ globals: new Int32Array(1024), locals: new Int32Array(512) });
test("FES expressions support authored computed variable indexes, assignments and signed integer math", () => {
  const context = state(); assert.equal(expression("$10 = 4", context), 4);
  assert.equal(expression("\\($10+2) = -17", context), -17); assert.equal(context.locals[6], -17);
  assert.equal(expression("\\6 /= 3", context), -5); assert.equal(expression("\\6++", context), -5); assert.equal(expression("++\\6", context), -3);
  assert.equal(expression("0x7fffffff + 1", context), -2147483648); assert.equal(expression("-8 >> 2", context), -2);
  assert.equal(expression("1+2*3==7 && 9>=8", context), 1); assert.equal(expression("0 && (1/0)", context), 0);
});
test("FES expressions resolve object/system/current values without JavaScript evaluation", () => {
  const context = { ...state(), current: 2, resolveName: (name, index) => name === "buttons" ? 20 + index : name === "_FRAME_" ? 42 : NaN };
  assert.equal(expression("buttons[3]==23 && _FRAME_>40 && @==2", context), 1);
  for (const source of ["process.exit()", "unknown", "\\512", "$1024", "$(-1)", "1/0", "1=2", "1.5", "\\(2", "0x100000000"]) assert.throws(() => expression(source, context), /FES/);
  assert.throws(() => parseExpression("(".repeat(70) + "1" + ")".repeat(70)), /nesting/);
});
