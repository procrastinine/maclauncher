const test = require("node:test"), assert = require("node:assert/strict");
const { FrontEndMachine } = require("../src/modules/catsystem2/runtime/frontend-vm");

test("FES calls, branches and next follow authored frame boundaries", async () => {
  const vm = new FrontEndMachine(`#START
$0 = 4
call SUB
next HOLD
#SUB
if ($0==4)
$1 = 7
else
$1 = 99
endif
break
$1 = 100
#HOLD
$2++
if ($2==3)
exit $1
endif`);
  const first = await vm.tick(0); assert.equal(first.active, "HOLD"); assert.equal(vm.globals[1], 7); assert.equal(vm.globals[2], 1);
  await vm.tick(1); assert.equal(vm.globals[2], 2);
  assert.equal((await vm.tick(2)).exitCode, 7);
});

test("FES waits preserve continuation while events use bank indexes and default ordering", async () => {
  const object = { group: "button", index: 3, handle: 4, defaultHandler: "common" }, operations = [];
  const vm = new FrontEndMachine(`#START
wait 8
$9 = 1
next HOLD
#HOLD
#common.PUSH_L
$0 = 1
#button.PUSH_L
if ($0==1)
\\0 = @
@ setid 3
next EXIT
endif
#EXIT
exit \\0`, { host: { command: async (name, args, machine) => { operations.push([name, args, machine.currentObject]); return name === "@"; } } });
  await vm.tick(0); vm.queueEvent(object, "PUSH_L");
  const result = await vm.tick(1); assert.equal(result.exitCode, 3); assert.equal(vm.globals[9], 0); assert.equal(operations[0][2], object);
});

test("FES object waits track actual completion and keep games independent", async () => {
  let busy = true;
  const vm = new FrontEndMachine("#START\nwait\nexit 9", { host: { isBusy: async () => busy } }), other = new FrontEndMachine("#START\nexit 2");
  await vm.tick(0); assert.equal((await vm.tick(1)).waiting, true); assert.equal((await other.tick(0)).exitCode, 2);
  busy = false; assert.equal((await vm.tick(2)).exitCode, 9);
});

test("FES exit reports to the parent while authored screen code continues until endfes", async () => {
  const vm = new FrontEndMachine("#START\nexit 7\n$1 = _EXITCODE_\nnext SLEEP\n#SLEEP");
  const state = await vm.tick(0); assert.equal(state.done, false); assert.equal(state.exitCode, 7); assert.equal(state.active, "SLEEP"); assert.equal(vm.globals[1], -1);
  await vm.tick(1); vm.stop(); assert.equal((await vm.tick(2)).done, true);
  const signed = new FrontEndMachine("#START\nexit -2\nnext SLEEP\n#SLEEP"); assert.equal((await signed.tick(0)).exitCode, -2);
});

test("FES rejects unknown services, unsafe flow, malformed conditions and event waits", async () => {
  assert.throws(() => new FrontEndMachine("#START\nelse"), /Unmatched/);
  assert.throws(() => new FrontEndMachine("#START\nif (1)\nexit 0"), /Incomplete/);
  await assert.rejects(new FrontEndMachine("#START\nunsupported 1").tick(0), /Unsupported FES command/);
  await assert.rejects(new FrontEndMachine("#START\nnext START").tick(0), /instruction limit/);
  const vm = new FrontEndMachine("#START\n#button.PUSH_L\nwait 1"); vm.queueEvent({ group: "button", index: 0 }, "PUSH_L");
  await assert.rejects(vm.tick(0), /events cannot wait/);
});
