const test = require("node:test"), assert = require("node:assert/strict");
const { createInputQueue } = require("../src/modules/catsystem2/runtime/frontend-input");
const { parseFrontEnd } = require("../src/modules/catsystem2/frontend-parser");
const { FrontEndMachine } = require("../src/modules/catsystem2/runtime/frontend-vm");
const { FrontEndObjects } = require("../src/modules/catsystem2/runtime/frontend-objects");
function screen() {
  const source = `#DEFINE
BUTTON item[2]
#OBJECT FILE ID.0 ID.1 POS DISP ENABLE TYPE
item[0] menu 0 1 0,0 1 1 0
item[1] menu 0 1 10,0 1 1 0
#START
next WAIT
#WAIT
#item.FOCUS
$(20+@)=1
@ setid 1
#item.UNFOCUS
$(20+@)=0
@ setid 0
#item.PUSH_L
$10=@+1
$11=_CLICK_L_
#item.RELEASE_L
$12=@+1`;
  const program = parseFrontEnd(source), originals = Buffer.from([20,30,40,255,20,30,40,0]), preserved = Buffer.from(originals);
  const objects = new FrontEndObjects(program, { canvas: { width: 30, height: 10 }, loadFrame: async () => ({ width: 2, height: 1, rgba: originals, rgbaPath: "/cache/menu.rgba" }) });
  const machine = new FrontEndMachine(program, { host: { tick: (...args) => objects.tick(...args), command: (...args) => objects.command(...args),
    resolveObject: (...args) => objects.resolveObject(...args), resolveTargets: (...args) => objects.resolveTargets(...args) } });
  return { machine, objects, originals, preserved };
}
test("native input drives authored focus, pixel hit testing and captured release without fabricated selection", async () => {
  const input = createInputQueue(), { machine, objects, originals, preserved } = screen(); await machine.tick(0);
  input.enqueue({ type: "pointer", kind: "move", x: 10.6, y: 0.2 }); await machine.tick(1, input.drain());
  assert.equal(machine.globals[21], 1); assert.equal(machine.globals[10], 0); assert.equal(objects.objects.get("item[1]").selected, 1);
  input.enqueue({ type: "pointer", kind: "down", button: 0, x: 10, y: 0 }); await machine.tick(2, input.drain());
  assert.equal(machine.globals[10], 2); assert.equal(machine.globals[11], 2);
  input.enqueue({ type: "pointer", kind: "up", button: 0, x: 1, y: 0 }); await machine.tick(3, input.drain());
  assert.equal(machine.globals[12], 2); assert.equal(machine.globals[21], 0); assert.equal(objects.focus, null);
  input.enqueue({ type: "pointer", kind: "down", button: 0, x: 1, y: 0 }); await machine.tick(4, input.drain()); assert.equal(machine.mouse.left, -1);
  assert.deepEqual(originals, preserved); input.close();
});
test("keyboard confirmation uses actual focus; repeated, oversized and malformed native input is bounded", async () => {
  const input = createInputQueue(), { machine } = screen(); await machine.tick(0);
  input.enqueue({ type: "pointer", kind: "move", x: 0, y: 0 }); await machine.tick(1, input.drain());
  input.enqueue({ type: "key", kind: "down", key: "Enter", repeat: false }); input.enqueue({ type: "key", kind: "down", key: "Enter", repeat: true });
  await machine.tick(2, input.drain()); assert.equal(machine.globals[10], 1);
  input.enqueue({ type: "key", kind: "up", key: "Enter", repeat: false }); await machine.tick(3, input.drain()); assert.equal(machine.globals[12], 1);
  for (const event of [{ type: "pointer", kind: "move", x: NaN, y: 0 }, { type: "pointer", kind: "down", x: 0, y: 0, button: 3 }, { type: "key", kind: "down", key: "Enter" }]) assert.throws(() => input.enqueue(event), /Invalid/);
  for (let index = 0; index < 256; index++) input.enqueue({ type: "pointer", kind: "move", x: index, y: 0 }); assert.throws(() => input.enqueue({ type: "pointer", kind: "move", x: 0, y: 0 }), /limit/);
  input.close(); assert.throws(() => input.drain(), /closed/);
});
test("pointer-retention mode preserves keyboard selection without retaining hover or invisible targets", async () => {
  const input=createInputQueue(),{machine,objects}=screen();objects.engineVersion="2.6.1.76";await machine.tick(0);
  objects.configurePointerFocus(1);input.enqueue({type:"pointer",kind:"move",x:10,y:0});await machine.tick(1,input.drain());
  input.enqueue({type:"pointer",kind:"move",x:29,y:9});await machine.tick(2,input.drain());
  assert.equal(objects.focus,null);assert.equal(machine.globals[21],0);assert.equal(objects.keyboardFocus.id,"item[1]");
  input.enqueue({type:"key",kind:"down",key:"Enter",repeat:false});await machine.tick(3,input.drain());assert.equal(machine.globals[10],2);
  input.enqueue({type:"key",kind:"up",key:"Enter",repeat:false});await machine.tick(4,input.drain());
  objects.objects.get("item[1]").visible=false;machine.globals[10]=0;
  input.enqueue({type:"key",kind:"down",key:"Enter",repeat:false});await machine.tick(5,input.drain());assert.equal(machine.globals[10],0);
  input.enqueue({type:"key",kind:"up",key:"Enter",repeat:false});await machine.tick(6,input.drain());
  objects.configurePointerFocus(0);input.enqueue({type:"pointer",kind:"move",x:29,y:9});await machine.tick(7,input.drain());assert.equal(objects.keyboardFocus,null);
  assert.throws(()=>objects.configurePointerFocus(2),/unsupported/);input.close();
});
