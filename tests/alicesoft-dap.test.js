const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { DapTransport, encodeRequest } = require("../src/modules/alicesoft/dap");
const Symbols = require("../src/modules/alicesoft/debug-symbols");
const { LiveVariablesSession, resolveAdapter, startSession, getSession, getSessionState, closeEditor } = require("../src/modules/alicesoft/live-variables");
const AliceSoft = require("../src/modules/alicesoft/main");

test("the inspector exposes live tools only for the reviewed generation", () => {
  assert.ok(AliceSoft.manifest.ui.actions.some(action => action.id === "openLiveVariables"));
  assert.ok(AliceSoft.manifest.ui.actionGroups.some(group => !group.collapsed && group.actions.includes("openLiveVariables")));
  assert.equal(typeof AliceSoft.actions.openLiveVariables, "function");
  assert.equal(AliceSoft.isActionAvailable("openLiveVariables", { moduleData: { generation: "system35" } }), true);
  for (const generation of ["system3", "system4"]) {
    assert.equal(AliceSoft.isActionAvailable("openLiveVariables", { moduleData: { generation } }), false);
  }
});

function childProcess() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.writes = [];
  child.stdin.write = (bytes, callback) => { child.writes.push(bytes); callback?.(); return true; };
  return child;
}
function frame(message) { return encodeRequest(message); }

test("DAP uses UTF-8 byte framing and the reviewed native input terminator", () => {
  const bytes = encodeRequest({ command: "setVariable", arguments: { value: "雪" } }, { terminalNul: true });
  const boundary = bytes.indexOf("\r\n\r\n");
  assert.equal(Number(/Content-Length: (\d+)/.exec(bytes.subarray(0, boundary).toString())[1]), bytes.length - boundary - 4);
  assert.equal(bytes.at(-1), 0);
  assert.equal(JSON.parse(bytes.subarray(boundary + 4, -1)).arguments.value, "雪");
});

test("DAP aggregates partial frames, correlates concurrent replies and drains native events", async t => {
  const child = childProcess(), transport = new DapTransport(child);
  t.after(() => transport.fail(new Error("test finished")));
  const first = transport.request("variables"), second = transport.request("scopes");
  const output = [];
  transport.on("event", event => output.push(event));
  const data = Buffer.concat([Buffer.from("native startup\n"), frame({ type: "event", event: "output", body: { output: "雪" } }),
    frame({ type: "response", request_seq: 2, success: true, body: { scopes: [] } }),
    frame({ type: "response", request_seq: 1, success: true, body: { variables: [{ name: "VAR1", value: "7" }] } })]);
  for (let index = 0; index < data.length; index += 7) child.stdout.emit("data", data.subarray(index, index + 7));
  assert.equal((await first).variables[0].value, "7");
  assert.deepEqual(await second, { scopes: [] });
  assert.equal(output[0].body.output, "雪");
  assert.match(transport.diagnostics, /native startup/);
  assert.equal(transport.pending.size, 0);
});

test("native errors, bounded frames and child exit reject outstanding work", async () => {
  const child = childProcess(), transport = new DapTransport(child);
  const request = transport.request("setVariable");
  child.stdout.emit("data", frame({ type: "response", request_seq: 1, success: false, message: "invalid variable name" }));
  await assert.rejects(request, /invalid variable name/);
  const waiting = transport.request("pause");
  child.stdout.emit("data", Buffer.from("Content-Length: 999999999\r\n\r\n"));
  await assert.rejects(waiting, /frame length/);
  assert.equal(transport.closed, true);
  assert.equal(transport.pending.size, 0);
  // The native process remains drained even when its protocol is invalid.
  child.stdout.emit("data", Buffer.from("still running"));
  assert.match(transport.diagnostics, /still running/);
  const anotherChild = childProcess(), another = new DapTransport(anotherChild);
  const pending = another.request("variables");
  anotherChild.emit("exit", 0, null);
  await assert.rejects(pending, /Game exited/);
});

test("DAP timeout clears requests and event waiters are cancelled on closure", async () => {
  const child = childProcess(), transport = new DapTransport(child, { timeout: 15 });
  await assert.rejects(transport.request("initialize"), /timed out/);
  assert.equal(transport.pending.size, 0);
  const waiting = transport.waitFor("stopped");
  transport.fail(new Error("closed by test"));
  await assert.rejects(waiting, /closed by test/);
  assert.equal(transport.listenerCount("event"), 0);
});

test("retail debugger symbols map all bounded variable indices and avoid duplicate names", () => {
  const names = Symbols.variableNames(["money", "money", "VAR3"]);
  assert.equal(names.length, 65536);
  assert.equal(names[0], "money");
  assert.equal(names[1], "[variable 1]");
  assert.equal(new Set(names).size, names.length);
  const bytes = Symbols.encodeSymbols(names);
  assert.equal(bytes.subarray(0, 4).toString(), "DSYM");
  assert.equal(bytes.readUInt32LE(4), 0);
  assert.equal(bytes.readUInt32LE(8), 1);
  assert.equal(bytes.subarray(12, 16).toString(), "VARI");
  assert.equal(bytes.readUInt32LE(16), bytes.length - 12);
  assert.equal(bytes.readUInt32LE(20), 65536);
  assert.throws(() => Symbols.encodeSymbols(["x\0y"]), /labels/);
});

test("retail debug preparation links assets and owns only metadata without changing original symbols", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-dap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, "original"), userDataDir = path.join(root, "appdata");
  fs.mkdirSync(original);
  const scenarioPath = path.join(original, "testSA.ALD");
  fs.writeFileSync(scenarioPath, "immutable scenario");
  fs.writeFileSync(scenarioPath + ".symbols", "original debug data");
  fs.mkdirSync(path.join(original, "assets"));
  fs.writeFileSync(path.join(original, "assets", "image.png"), "immutable image");
  const args = { entry: { gameId: "fixture", contentRootDir: original }, userDataDir, scenarioPath };
  const result = Symbols.prepareDebugDirectory(args);
  assert.equal(fs.readlinkSync(path.join(result.directory, "testSA.ALD")), fs.realpathSync(scenarioPath));
  assert.equal(fs.readlinkSync(path.join(result.directory, "assets")), fs.realpathSync(path.join(original, "assets")));
  assert.equal(fs.lstatSync(result.symbolsPath).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(scenarioPath + ".symbols", "utf8"), "original debug data");
  assert.equal(Symbols.prepareDebugDirectory(args).directory, result.directory);
  fs.writeFileSync(result.symbolsPath, "changed");
  assert.throws(() => Symbols.prepareDebugDirectory(args), /metadata changed/);
});

test("optional System39 name parsing is bounded and names enrich the live view", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-ain-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(39);
  bytes.write("AINI", 0); bytes.write("HEL0", 8); bytes.writeUInt32LE(0, 16);
  bytes.write("VARI", 20); bytes.writeUInt32LE(1, 28); bytes.write("money\0", 32);
  for (let index = 4; index < bytes.length; index++) bytes[index] = (bytes[index] >> 2 | bytes[index] << 6) & 255;
  const file = path.join(root, "System39.ain");
  fs.writeFileSync(file, bytes);
  assert.deepEqual(Symbols.readAinVariableNames(file), ["money"]);
  fs.writeFileSync(file, bytes.subarray(0, 34));
  assert.deepEqual(Symbols.readAinVariableNames(file), []);
  assert.deepEqual(Symbols.readAinVariableNames(path.join(root, "missing")), []);
});

function nativeAdapter() {
  const child = childProcess();
  child.pid = 42;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin.end = () => { child.inputEnded = true; };
  child.kill = signal => { child.signalCode = signal; child.emit("exit", null, signal); };
  const globals = [0, 17, 31], strings = ["\"original\""];
  child.commands = [];
  child.stdin.write = (bytes, callback) => {
    const offset = bytes.indexOf("\r\n\r\n") + 4;
    const command = JSON.parse(bytes.subarray(offset, -1));
    child.commands.push(command);
    callback?.();
    queueMicrotask(() => {
      let body = {};
      const { arguments: args } = command;
      if (command.command === "scopes") body = { scopes: [
        { name: "All Variables", variablesReference: 1, namedVariables: globals.length },
        { name: "Strings", variablesReference: 2, indexedVariables: strings.length }
      ] };
      else if (command.command === "variables") {
        const values = args.variablesReference === 1 ? globals : strings;
        body = { variables: values.slice(args.start, args.start + args.count).map((value, index) => ({
          name: args.variablesReference === 1 ? `VAR${args.start + index}` : `[${args.start + index}]`, value: String(value)
        })) };
      } else if (command.command === "setVariable") {
        const index = Number(args.name.replace(/\D/g, ""));
        const values = args.variablesReference === 1 ? globals : strings;
        values[index] = args.variablesReference === 1 ? Number(args.value) : args.value;
        body = { value: String(values[index]) };
      }
      child.stdout.emit("data", frame({ type: "response", request_seq: command.seq, command: command.command, success: true, body }));
      if (["configurationDone", "pause"].includes(command.command)) {
        child.stdout.emit("data", frame({ type: "event", event: "stopped", body: { reason: "pause" } }));
      } else if (command.command === "disconnect") {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      }
    });
    return true;
  };
  return child;
}

const runtime = { runtimeVersion: "2.20.0", upstreamRevision: "82c8b76a58a19ff1f87b4bdadbaef169c4b37f46", debugAdapter: "dap-terminal-nul-v1" };

test("live variables use the declared debug adapter; edits pause, validate and read back the same native cell", async () => {
  assert.equal(resolveAdapter(runtime).terminalNul, true);
  assert.equal(resolveAdapter({ ...runtime, runtimeVersion: "MCLv2-1101", upstreamRevision: "a".repeat(40) }).terminalNul, true,
    "Any version that declares the adapter is accepted");
  assert.throws(() => resolveAdapter({ ...runtime, debugAdapter: undefined }), /debug adapter/);
  assert.throws(() => resolveAdapter({ ...runtime, debugAdapter: "dap-v2" }), /debug adapter/);
  const child = nativeAdapter(), session = new LiveVariablesSession({ child, runtime, prepared: {} });
  await session.initialize();
  assert.equal(session.getState().phase, "paused");
  assert.deepEqual((await session.list()).variables.map(row => row.value), ["0", "17", "31"]);
  assert.equal((await session.set({ index: 1, value: "65535" })).value, "65535");
  assert.equal((await session.set({ scope: "strings", index: 0, value: '雪 "quoted"' })).value, '"雪 "quoted""');
  assert.equal((await session.list({ scope: "strings" })).variables[0].value, '"雪 "quoted""');
  for (const value of ["65536", "-1", "1.5", "1 trailing", "0x10", "007;anything"]) {
    await assert.rejects(session.set({ index: 1, value }), /integer/);
  }
  await assert.rejects(session.set({ scope: "strings", index: 0, value: "x\0y" }), /NUL/);
  await assert.rejects(session.list({ start: -1 }), /scope/);
  await assert.rejects(session.list({ count: 257 }), /256/);
  await session.stop();
  assert.equal(session.getState().phase, "exited");
});

test("closing live tools resumes its owned game and retains the transport; pause can reopen it", async () => {
  const child = nativeAdapter(), session = new LiveVariablesSession({ child, runtime, prepared: {} });
  await session.initialize();
  await session.closeEditor();
  assert.equal(session.getState().phase, "running");
  assert.equal(child.inputEnded, undefined);
  assert.equal(child.commands.some(command => command.command === "disconnect"), false);
  assert.equal(session.transport.closed, false);
  await assert.rejects(session.set({ index: 0, value: "1" }), /Pause/);
  await session.pause();
  assert.equal(session.getState().phase, "paused");
  assert.equal((await session.set({ index: 0, value: 12 })).value, "12");
  await session.stop();
  assert.equal(session.getState().exitCode, 0);
});

test("native exit leaves readable terminal status, harmless editor closure and strict session controls", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alicesoft-live-exit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(Symbols, "prepareDebugDirectory", () => ({ directory: root }));
  const entry = { gameId: "exit-status" }, context = { userDataDir: root }, child = nativeAdapter();
  const session = await startSession({ entry, userDataDir: root, runtime, scenarioPath: "fixture.ald", spawn: () => child });
  const payload = { sessionId: session.id };
  assert.equal(getSessionState(entry, context, payload).phase, "paused");
  assert.equal(AliceSoft.actions.liveVariableStatus(entry, payload, context).phase, "paused");
  await session.stop();
  const ended = getSessionState(entry, context, payload);
  assert.equal(ended.phase, "exited");
  assert.equal(ended.exitCode, 0);
  assert.equal(ended.sessionId, session.id);
  assert.deepEqual(await closeEditor(entry, context, payload), ended);
  assert.deepEqual(await AliceSoft.actions.closeLiveVariables(entry, payload, context), ended);
  assert.throws(() => getSession(entry, context, payload), /ended/);
  assert.throws(() => AliceSoft.actions.listLiveVariables(entry, payload, context), /ended/);
  assert.equal(getSessionState(entry, context, { sessionId: "stale" }).phase, "unavailable");
  assert.equal(getSessionState({ gameId: "another-game" }, context, payload).pid, null);
  assert.throws(() => getSessionState(entry, context, { sessionId: "bad\0id" }), /valid/);
  ended.scopes[0].count = 999;
  assert.notEqual(getSessionState(entry, context, payload).scopes[0].count, 999);
});
