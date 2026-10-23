const test = require("node:test"), assert = require("node:assert/strict"), zlib = require("node:zlib");
const { createFrontEndHost } = require("../src/modules/catsystem2/runtime/frontend-host"), { createTaskRegistry } = require("../src/modules/catsystem2/runtime/tasks");
function fes(source) { const raw = Buffer.from(source + "\0"), packed = zlib.deflateSync(raw), header = Buffer.alloc(16); header.write("FES"); header.writeUInt32LE(packed.length, 4); header.writeUInt32LE(raw.length, 8); return Buffer.concat([header, packed]); }
function host(sources, extra = {}) {
  const tasks = createTaskRegistry(), variables = new Int32Array(1024), strings = new Map(), reads = [], preserved = new Map([...sources].map(([n, b]) => [n, Buffer.from(b)]));
  const runtime = createFrontEndHost({ tasks, canvas: { width: 100, height: 60 }, kernelState: { variables, strings },
    assets: { exists: async name => name === "story.int/intro.cst" }, registry: { read: async (type, name) => { assert.equal(type, "fes"); reads.push(name); return sources.get(name); } }, ...extra });
  return { runtime, tasks, variables, strings, reads, preserved };
}
test("KCS solid plane rendering applies authored base coordinates and rejects unknown backing pixels", async () => {
  const scenes = [], { runtime, tasks } = host(new Map(), { colorFrame: async (width, height) => ({ rgbaPath: "/cache/plane.rgba", width, height }), present: async scene => scenes.push(scene) });
  const plane = tasks.create(2, 1, "plane"), { OFFSET } = require("../src/modules/catsystem2/runtime/motion-vm");
  tasks.initializePlane(plane.id, 100, 60); await assert.rejects(runtime.tick(0), /not initialized for display/);
  const other = host(new Map(), { colorFrame: async (width, height) => ({ rgbaPath: "/cache/plane.rgba", width, height }), present: async scene => scenes.push(scene) });
  const filled = other.tasks.create(2, 1, "solid"); other.tasks.size(filled.id, 100, 60, 0); other.tasks.fillPlane(filled.id, 0xff010203, 1); other.tasks.base(filled.id, 50, 30, 0);
  filled.bytes.writeFloatLE(55, OFFSET.position); filled.bytes.writeFloatLE(38, OFFSET.position + 4);
  await other.runtime.tick(0); assert.deepEqual([scenes[0].layers[0].x, scenes[0].layers[0].y], [5, 8]);
});
test("FES activation and child completion follow original screen commands and shared authored flags", async () => {
  const sources = new Map([["root", fes("#START\nfileexist story.int/intro.cst 9\nexecfes menu\nnext HOLD\n#HOLD\nif (_EXITCODE_==7)\n$10 = 1\nendfes\nnext DONE\nendif\n#DONE")], ["menu", fes("#START\n$11 = 8\nexit 7\nnext SLEEP\n#SLEEP")]]);
  const { runtime, tasks, variables, preserved } = host(sources), task = tasks.create(34, 1, "root"); await runtime.load(task.id, "root");
  await runtime.tick(0); assert.equal(variables[9], 0); assert.equal(runtime.record(task.id).frame, -1);
  await runtime.start(task.id); assert.equal(variables[9], 1); assert.equal(variables[11], 0); assert.equal(runtime.scripts.size, 2);
  const child = runtime.record(task.id).child; assert.notEqual(child, null);
  await runtime.tick(1); assert.equal(variables[11], 8); assert.equal(variables[10], 1); assert.equal(runtime.scripts.size, 1);
  assert.equal(tasks.tasks.has(child), false); assert.equal(runtime.record(task.id).machine.childExitCode, -1);
  for (const [name, source] of sources) assert.deepEqual(source, preserved.get(name));
  await assert.rejects(runtime.start(task.id), /already started/); await assert.rejects(runtime.tick(1), /frame sequence/);
});
test("FES unresolved services and incompatible formats remain explicit before choosing any replacement screen", async () => {
  const sources = new Map([["root", fes("#START\nunsupported_host 1")]]), { runtime, tasks, reads } = host(sources);
  const task = tasks.create(34, 1, "root"); await runtime.load(task.id, "root");
  await assert.rejects(runtime.start(task.id), /Unsupported FES command/); assert.deepEqual(reads, ["root"]);
  sources.set("bad", Buffer.from("not a screen")); await assert.rejects(runtime.load(task.id, "bad"), /signature/);
  assert.equal(runtime.record(task.id).name, "root");
});
test("FES opaque Unicode diagnostics leave ASCII authored control flow and state intact", async () => {
  const bytes = fes('#START\ndbgstr "—"\n$9=17\nexit 0'), original = Buffer.from(bytes), traces = [];
  const { runtime, tasks, variables } = host(new Map([["menu", bytes]]), { engineVersion: "2.6.1.76", trace: event => traces.push(event) });
  const task = tasks.create(34, 1, "menu"); await runtime.load(task.id, "menu"); await runtime.start(task.id);
  assert.equal(variables[9], 17); assert.ok(traces.some(event => event.command === "dbgstr")); assert.deepEqual(bytes, original);
  const bad = host(new Map([["menu", fes('#START\nstrvar 2 "—"')]]), { engineVersion: "2.6.1.76" });
  await assert.rejects(bad.runtime.load(bad.tasks.create(34, 1, "menu").id, "menu"), /executable string encoding/);
});
test("FES cursor commands apply authored names and hotspots through the native service", async () => {
  const changes=[],sources=new Map([["menu",fes("#START\nxchgcursor hover 3 4\nxchgcursor\nexit 5")]]);
  const {runtime,tasks}=host(sources,{cursor:{select:async(...args)=>changes.push(args)}}),task=tasks.create(34,1,"menu");
  await runtime.load(task.id,"menu");assert.equal((await runtime.start(task.id)).exitCode,5);assert.deepEqual(changes,[["hover",[3,4]],["default",undefined]]);
  const missing=host(sources),absent=missing.tasks.create(34,1,"menu");await missing.runtime.load(absent.id,"menu");
  await assert.rejects(()=>missing.runtime.start(absent.id),/cursor command is unsupported/);
});
test("FES authored frames continue while identical native scenes are reused", async () => {
  const scenes=[],sources=new Map([["menu",fes("#DEFINE\nCIMAGE bg\n#OBJECT SIZE DISP BLEND\nbg 1,1 1 255\n#START\nnext WAIT\n#WAIT\nif (_FRAME_==3)\nbg disp 0\nendif")]]);
  const {runtime,tasks}=host(sources,{colorFrame:async()=>({rgbaPath:'/cache/pixel.rgba',width:1,height:1}),present:async scene=>scenes.push(scene)}),task=tasks.create(34,1,"menu");
  await runtime.load(task.id,"menu");await runtime.start(task.id);await runtime.tick(0);await runtime.tick(1);
  assert.equal(scenes.length,1);assert.equal(runtime.record(task.id).machine.frame,2);await runtime.tick(2);
  assert.equal(scenes.length,2);assert.equal(scenes[1].layers.length,0);assert.equal(runtime.record(task.id).machine.frame,3);
});
test("FES force_redraw presents unchanged decoded layers at the authored frame", async () => {
  const scenes = [], sources = new Map([["screen", fes("#DEFINE\nCIMAGE bg\n#OBJECT SIZE DISP\nbg 1,1 1\n#START\nnext WAIT\n#WAIT\nif (_FRAME_==2)\nforce_redraw\nendif")]]);
  const { runtime, tasks } = host(sources, { engineVersion: "2.6.1.76", colorFrame: async () => ({ rgbaPath: "/cache/pixel.rgba", width: 1, height: 1 }), present: async scene => scenes.push(scene) });
  const task = tasks.create(34,1,"screen"); await runtime.load(task.id,"screen"); await runtime.start(task.id);
  await runtime.tick(0); await runtime.tick(1); await runtime.tick(2);
  assert.equal(scenes.length, 2); assert.deepEqual(scenes[0],scenes[1]);
  const unsupported = host(sources, { engineVersion: "2.6.0", colorFrame: async () => ({ rgbaPath: "/cache/pixel.rgba", width: 1, height: 1 }) }), other = unsupported.tasks.create(34,1,"screen");
  await unsupported.runtime.load(other.id,"screen"); await unsupported.runtime.start(other.id); await unsupported.runtime.tick(0);
  await assert.rejects(unsupported.runtime.tick(1), /redraw profile/);
});
test("FES save-slot commands retain mismatch results and execute authored private operations", async () => {
  const calls=[],sources=new Map([["menu",fes("#START\nsaveexist 7000 9 17 20\nif ($9==-1)\nsavecopy 7000 7001\nsavedelete 7000\nendif\nsaveexist 3 10\nexit 0")]]);
  const saveSlots={exists:async(...args)=>{calls.push(['exists',...args]);return args[0]===7000?-1:0;},copy:async(...args)=>calls.push(['copy',...args]),remove:async(...args)=>calls.push(['remove',...args])};
  const {runtime,tasks,variables}=host(sources,{saveSlots}),task=tasks.create(34,1,"menu");await runtime.load(task.id,"menu");await runtime.start(task.id);
  assert.deepEqual(calls,[['exists',7000,17,20],['copy',7000,7001],['remove',7000],['exists',3,-1,-1]]);assert.equal(variables[9],-1);assert.equal(variables[10],0);
  const absent=host(sources),missing=absent.tasks.create(34,1,"menu");await absent.runtime.load(missing.id,"menu");await assert.rejects(absent.runtime.start(missing.id),/save-slot access is unavailable/);
});
test("KCS initialization writes only the loaded screen's bounded FES local region", async () => {
  const sources=new Map([["menu",fes("#START\n$9 = \\0\nexit 0")]]),{runtime,tasks,variables}=host(sources),task=tasks.create(34,1,"menu");
  await runtime.load(task.id,"menu");runtime.setLocal(task.id,0,37);await runtime.start(task.id);assert.equal(variables[9],37);
  assert.equal(runtime.getLocal(task.id,0),37);assert.equal(runtime.getLocal(task.id,1),0);
  for(const index of [-1,512,NaN])assert.throws(()=>runtime.getLocal(task.id,index),/local index exceeds/);
  for(const [index,value] of [[-1,0],[512,0],[0,0x80000000],[0,NaN]])assert.throws(()=>runtime.setLocal(task.id,index,value),/local value exceeds/);
  assert.equal(runtime.record(task.id).machine.locals[0],37);assert.throws(()=>runtime.setLocal(65530,0,1),/handle is absent/);
});
test("FES child kernels retain an immediate authored exit code and use their explicit shutdown adapter", async () => {
  const changes = [], sources = new Map([["parent", fes("#START\nexeckcs child\nif (_EXITCODE_==7)\n$9=1\nendkcs\nendif\nnext IDLE\n#IDLE")]]);
  const kernelTasks = { create: async ({ parentId, name, onExitCode }) => { changes.push(["create", parentId, name]); await onExitCode(7); return { id: 10 }; }, remove: async id => changes.push(["remove", id]) };
  const { runtime, tasks, variables } = host(sources, { kernelTasks }), parent = tasks.create(34, 1, "parent");
  await runtime.load(parent.id, "parent"); await runtime.start(parent.id);
  assert.deepEqual(changes, [["create", parent.id, "child"], ["remove", 10]]); assert.equal(variables[9], 1);
  assert.equal(runtime.record(parent.id).kernel, null); assert.equal(runtime.record(parent.id).machine.childExitCode, -1);
});
test("FES background-button reset removes only that screen's owned input task", async () => {
  const sources = new Map([["screen", fes("#START\ndeletebgbutton\n$9=17\nnext IDLE\n#IDLE")]]), { runtime, tasks, variables } = host(sources, { engineVersion: "2.6.1.76" });
  const screen = tasks.create(34, 1, "screen"), another = tasks.create(34, 1, "other"), foreign = tasks.create(6, another.id, "other-background");
  await runtime.load(screen.id, "screen"); const owned = tasks.create(6, screen.id, "background"); runtime.record(screen.id).backgroundButton = owned.id;
  await runtime.start(screen.id); assert.equal(tasks.tasks.has(owned.id), false); assert.equal(tasks.tasks.has(foreign.id), true);
  assert.equal(runtime.record(screen.id).backgroundButton, null); assert.equal(variables[9], 17);
  const empty = host(sources, { engineVersion: "2.6.1.76" }), emptyScreen = empty.tasks.create(34, 1, "screen"); await empty.runtime.load(emptyScreen.id, "screen");
  await empty.runtime.start(emptyScreen.id); assert.equal(empty.variables[9], 17);
  const invalid = host(sources, { engineVersion: "2.6.1.76" }), invalidScreen = invalid.tasks.create(34, 1, "screen"), wrong = invalid.tasks.create(6, 1, "other");
  await invalid.runtime.load(invalidScreen.id, "screen"); invalid.runtime.record(invalidScreen.id).backgroundButton = wrong.id;
  await assert.rejects(invalid.runtime.start(invalidScreen.id), /belongs to another screen/); assert.equal(invalid.tasks.tasks.has(wrong.id), true);
});
test("FES message-window reset invokes the real kernel broadcast and guards other menu actions", async () => {
  let changes = 0; const sources = new Map([["screen", fes("#MACRO\nRESET_WINDOW 13\n#START\nwndmenu RESET_WINDOW\n$9=1\nnext IDLE\n#IDLE")]]);
  const { runtime, tasks, variables } = host(sources, { engineVersion: "2.6.1.76", kernelTasks: { resetMessageWindow() { changes++; } } });
  const task = tasks.create(34,1,"screen"); await runtime.load(task.id,"screen"); await runtime.start(task.id);
  assert.equal(changes,1); assert.equal(variables[9],1);
  const unsupported = host(new Map([["screen",fes("#START\nwndmenu 2")]]), { engineVersion: "2.6.1.76", kernelTasks: { resetMessageWindow() { changes++; } } });
  const other = unsupported.tasks.create(34,1,"screen"); await unsupported.runtime.load(other.id,"screen");
  await assert.rejects(unsupported.runtime.start(other.id), /window-menu action/); assert.equal(changes,1);
});
test("FES achievements follow explicit adapter availability without inventing an online result", async () => {
  const sources = new Map([["screen",fes("#START\nsteam_achievement CHAPTER_UNLOCK\n$9=1\nexit 0")]]), changes = [];
  for (const enabled of [false,true]) {
    const { runtime,tasks,variables } = host(sources,{engineVersion:"2.6.1.76",steam:{enabled,setAchievement:async name=>{changes.push(name);return false;}}});
    const task=tasks.create(34,1,"screen");await runtime.load(task.id,"screen");await runtime.start(task.id);assert.equal(variables[9],1);
  }
  assert.deepEqual(changes,["CHAPTER_UNLOCK"]);
  const missing=host(sources,{engineVersion:"2.6.1.76",steam:{enabled:true}}),task=missing.tasks.create(34,1,"screen");await missing.runtime.load(task.id,"screen");
  await assert.rejects(missing.runtime.start(task.id),/achievements are unavailable/);assert.equal(missing.variables[9],0);
});
test("the measured decode setter suspends the authored screen and changes pointer retention only", async () => {
  const sources = new Map([["screen",fes("#START\ndecode 1\n$9=17\ndecode\n$10=23\nnext IDLE\n#IDLE")]]);
  const {runtime,tasks,variables}=host(sources,{engineVersion:"2.6.1.76"}),task=tasks.create(34,1,"screen");
  await runtime.load(task.id,"screen"); const started=await runtime.start(task.id);
  assert.equal(started.waiting,true); assert.equal(variables[9],0); assert.equal(runtime.record(task.id).objects.retainPointerFocus,true);
  await runtime.tick(0); assert.equal(variables[9],17); assert.equal(variables[10],0); assert.equal(runtime.record(task.id).objects.retainPointerFocus,false);
  await runtime.tick(1); assert.equal(variables[10],23); assert.equal(runtime.record(task.id).machine.waiting,null);
  const invalid=host(new Map([["screen",fes("#START\ndecode 2")]]),{engineVersion:"2.6.1.76"}),other=invalid.tasks.create(34,1,"screen");
  await invalid.runtime.load(other.id,"screen"); await assert.rejects(invalid.runtime.start(other.id),/pointer-focus mode/);
});
test("external FES callbacks execute their authored block and preserve normal scope and absent labels", async () => {
  const sources=new Map([["screen",fes("#DEFINE\nBUTTON item[2]\n#START\nwait 3\n$9=17\nnext IDLE\n#IDLE\n#QUERY\n$10=23\n#item.UPDATE\n$(20+@)=8")]]);
  const {runtime,tasks,variables}=host(sources,{engineVersion:"2.6.1.76"}),task=tasks.create(34,1,"screen");
  await runtime.load(task.id,"screen");await assert.rejects(runtime.callBlock(task.id,"QUERY"),/callback profile/);
  await runtime.start(task.id);const machine=runtime.record(task.id).machine, before={cursor:machine.cursor,waiting:machine.waiting,active:machine.active};
  assert.equal(await runtime.callBlock(task.id,"ABSENT"),false);assert.deepEqual({cursor:machine.cursor,waiting:machine.waiting,active:machine.active},before);
  assert.equal(await runtime.callBlock(task.id,"QUERY"),true);assert.equal(variables[10],23);assert.equal(variables[9],0);
  assert.equal(await runtime.callBlock(task.id,"UPDATE","item",1),true);assert.equal(variables[21],8);assert.equal(variables[20],0);
  assert.deepEqual({cursor:machine.cursor,waiting:machine.waiting,active:machine.active},before);assert.equal(machine.currentObject,null);
  for(let frame=0;frame<3;frame++)await runtime.tick(frame);assert.equal(variables[9],17);
  await assert.rejects(runtime.callBlock(task.id,"QUERY","missing",0),/object is absent/);
  await assert.rejects(runtime.callBlock(task.id,"bad label"),/callback profile/);
});
