const test = require("node:test"), assert = require("node:assert/strict");
const Shortcuts = require("../src/modules/shared/graphics-shortcuts.mjs");

test("shortcuts that macOS, the launcher or apps use are rejected", () => {
  for (const accelerator of ["Command+F", "Control+Command+F", "Command+Q", "Command+Shift+T", "Option+Command+Escape", "Control+Command+Space",
    "Control+Option+B", "Control+Shift+B", "Shift+F5", "F5", "Control+Shift+Command+3", "Control+Shift+Command+4", "Control+Option+Command+8"])
    assert.equal(Shortcuts.validate("bypass", accelerator).ok, false, accelerator);
  assert.match(Shortcuts.validate("screenshot", "Control+Shift+Command+3").reason, /macOS shortcut/);
});

test("Control with two other modifiers is accepted in canonical order", () => {
  assert.deepEqual(Shortcuts.validate("bypass", "Command+Option+Control+b"), {ok: true, accelerator: "Control+Option+Command+B"});
  assert.deepEqual(Shortcuts.validate("screenshot", "ctrl+shift+alt+F6"), {ok: true, accelerator: "Control+Option+Shift+F6"});
  assert.equal(Shortcuts.electronAccelerator("Control+Option+Command+B"), "Control+Alt+Command+B");
  assert.deepEqual(Shortcuts.validate("bypass", null), {ok: true, accelerator: null});
});

test("one shortcut cannot serve two actions, and malformed values are refused", () => {
  const assigned = {bypass: "Control+Option+Command+B"};
  assert.match(Shortcuts.validate("screenshot", "Command+Control+Option+B", assigned).reason, /already assigned/);
  assert.equal(Shortcuts.validate("bypass", "Control+Option+Command+B", assigned).ok, true);
  for (const value of ["Control+Option+Command", "Control+Option+Command+B+C", "Control+Control+Option+B", "Control+Option+Command+", 42, "x".repeat(80)])
    assert.equal(Shortcuts.validate("bypass", value).ok, false, String(value));
  assert.equal(Shortcuts.validate("unknown", "Control+Option+Command+B").ok, false);
  assert.deepEqual(Shortcuts.normalize({bypass: "Control+Option+Command+B", screenshot: "Control+Option+Command+B", extra: "Control+Option+Command+X"}),
    {bypass: "Control+Option+Command+B"});
});

test("a recorder maps key events by physical key", () => {
  assert.equal(Shortcuts.fromKeyboardEvent({code: "KeyS", ctrlKey: true, altKey: true, metaKey: true}), "Control+Option+Command+S");
  assert.equal(Shortcuts.fromKeyboardEvent({code: "Digit4", ctrlKey: true, shiftKey: true, metaKey: true}), "Control+Shift+Command+4");
  assert.equal(Shortcuts.fromKeyboardEvent({code: "ShiftLeft", shiftKey: true}), null);
});

test("one registry holds game shortcuts only while a game runs and reports taken shortcuts", () => {
  const Registry = require("../src/main/graphics-shortcuts");
  const held = new Map(), taken = new Set(["Control+Alt+Command+T"]);
  const globalShortcut = {register: (accelerator, run) => { if (taken.has(accelerator)) return false;held.set(accelerator, run);return true; },
    unregister: accelerator => held.delete(accelerator)};
  let assignments = {bypass: "Control+Option+Command+B", screenshot: "Control+Option+Command+T", windowGraphics: "Control+Option+Command+G"};
  const registry = Registry.create({globalShortcut, readAssignments: () => assignments});
  const calls = [];
  registry.handle("bypass", () => calls.push("bypass"));
  registry.handle("screenshot", () => calls.push("screenshot"));
  assert.deepEqual([...held.keys()], []);
  registry.handle("windowGraphics", () => calls.push("window"), {always: true});
  assert.deepEqual([...held.keys()], ["Control+Alt+Command+G"]);
  registry.setActive(true);
  assert.deepEqual([...held.keys()].sort(), ["Control+Alt+Command+B", "Control+Alt+Command+G"]);
  assert.equal(registry.status().find(item => item.action === "screenshot").reason, "Another app is using this shortcut.");
  assignments = {bypass: "Control+Shift+Command+B", windowGraphics: "Command+G"};registry.refresh();
  assert.deepEqual([...held.keys()], ["Control+Shift+Command+B"]);
  assert.deepEqual(registry.status().map(item => [item.action, item.accelerator, item.reason]),
    [["bypass", "Control+Shift+Command+B", undefined], ["screenshot", null, undefined], ["windowGraphics", null, undefined]]);
  registry.setActive(false);assert.deepEqual([...held.keys()], []);
  registry.setActive(true);registry.dispose();assert.deepEqual([...held.keys()], []);
});

test("a shortcut acts on the only game, else the frontmost one, else the latest", () => {
  const {chooseGame} = require("../src/main/graphics-shortcuts");
  assert.equal(chooseGame([], 1), null);
  assert.equal(chooseGame([{gamePath: "/a", pid: 5}], 9), "/a");
  assert.equal(chooseGame([{gamePath: "/a", pid: 5}, {gamePath: "/b", pid: 6}], 5), "/a");
  assert.equal(chooseGame([{gamePath: "/a", pid: 5}, {gamePath: "/b", pid: 6}], null), "/b");
  assert.equal(chooseGame([{gamePath: "/w", pid: 7, targetPid: 40}, {gamePath: "/b", pid: 6}], 40), "/w");
});

test("a shortcut acts on the game whose launched process started the frontmost app", async () => {
  const {chooseGame} = require("../src/main/graphics-shortcuts"), ProcessTree = require("../src/core/process-tree");
  // A Wine supervisor shell (100) starts wine (101), which starts a helper (102); another game runs as 200.
  const ps = "    1     0\n  100     1\n  101   100\n  102   101\n  200     1\n  300     1\n";
  const processes = await ProcessTree.list({execFile: (file, args, options, done) => { assert.deepEqual([file, args], ["/bin/ps", ["-axo", "pid=,ppid="]]); done(null, ps); }});
  const running = [{gamePath: "/wine", pid: 100}, {gamePath: "/other", pid: 200}];
  assert.equal(chooseGame(running, 101, processes), "/wine");
  assert.equal(chooseGame(running, 102, processes), "/wine");
  assert.equal(chooseGame(running, 200, processes), "/other");
  assert.equal(chooseGame(running, 300, processes), "/other");
  assert.equal(chooseGame(running, 101, []), "/other");
  assert.deepEqual(await ProcessTree.list({execFile: (file, args, options, done) => done(new Error("ps failed"))}), []);
});
