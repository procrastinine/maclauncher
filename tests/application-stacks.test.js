const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Stacks = require("../src/modules/shared/effects/application-stacks");
const WindowActions = require("../src/modules/window/app-actions");

const shader = id => ({ schema: 2, mode: "advanced", enabled: true, video: [{ id, kind: "shader", enabled: true, shader: { enabled: true, preset: "grayscale" } }] });
const app = bundleIdentifier => ({ target: "application", bundleIdentifier });
function library(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "application-stacks-"));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const file = root => JSON.parse(fs.readFileSync(Stacks.location(root), "utf8"));

test("a default stack is never stored and saving one removes its app", t => {
  const root = library(t);
  assert.equal(Stacks.save(root, app("com.example.one"), {}), "unchanged");
  assert.equal(fs.existsSync(Stacks.location(root)), false);
  assert.equal(Stacks.save(root, app("com.example.one"), { effects: { schema: 2, mode: "advanced", enabled: true, video: [] } }), "unchanged");
  assert.equal(Stacks.save(root, app("com.example.one"), { effects: shader("a"), runtimeSettings: { captureCursor: true } }), "saved");
  assert.deepEqual(Stacks.lookup(root, app("com.example.one")).runtimeSettings, { captureCursor: true });
  assert.equal(Stacks.lookup(root, app("com.example.one")).effects.video[0].id, "a");
  assert.equal(Stacks.save(root, app("com.example.one"), { effects: shader("a"), runtimeSettings: { captureCursor: true } }), "unchanged");
  assert.equal(Stacks.save(root, app("com.example.one"), {}), "removed");
  assert.deepEqual(file(root).stacks, {});
  assert.equal(Stacks.lookup(root, app("com.example.one")), null);
});

test("the store keeps at most 50 apps, least recently used first out, and bounds stack and file size", t => {
  const root = library(t);
  for (let index = 0; index < 52; index++) Stacks.save(root, app("com.example." + index), { effects: shader("row" + index) }, { now: 1000 + index });
  const names = Object.keys(file(root).stacks);
  assert.equal(names.length, Stacks.LIMITS.apps);
  assert.equal(names.includes("bundle:com.example.0") || names.includes("bundle:com.example.1"), false);
  assert.ok(names.includes("bundle:com.example.51"));
  assert.equal(Stacks.save(root, app("com.example.large"), { effects: shader("large"), runtimeSettings: { note: "x".repeat(Stacks.LIMITS.stackBytes) } }), "too-large");
  assert.ok(fs.statSync(Stacks.location(root)).size <= Stacks.LIMITS.fileBytes);
  assert.equal(Stacks.save(root, {}, { effects: shader("a") }), "skipped", "a stack needs an identity");
});

test("bundle-less processes and the display have their own keys; uninstalled apps are pruned", t => {
  const root = library(t), executable = path.join(root, "Game");
  fs.writeFileSync(executable, "");
  const process = { target: "application", executablePath: executable, name: "Game" };
  Stacks.save(root, process, { effects: shader("p") });
  Stacks.save(root, { target: "display" }, { effects: shader("d") });
  Stacks.save(root, app("com.example.kept"), { effects: shader("k") });
  Stacks.save(root, app("com.example.gone"), { effects: shader("g") });
  assert.deepEqual(Stacks.bundleIdentifiers(root).sort(), ["com.example.gone", "com.example.kept"]);
  assert.deepEqual(Stacks.prune(root, { "com.example.gone": false, "com.example.kept": true }), ["bundle:com.example.gone"]);
  fs.rmSync(executable);
  assert.deepEqual(Stacks.prune(root, {}), [Stacks.key(process)]);
  assert.deepEqual(Object.keys(file(root).stacks).sort(), ["bundle:com.example.kept", "display"]);
});

test("an unreadable store is kept aside and replaced; an unreadable plan is not applied", t => {
  const root = library(t);
  fs.mkdirSync(path.dirname(Stacks.location(root)), { recursive: true });
  fs.writeFileSync(Stacks.location(root), "{not json");
  assert.equal(Stacks.lookup(root, app("com.example.one")), null);
  assert.equal(Stacks.save(root, app("com.example.one"), { effects: shader("a") }), "saved");
  assert.ok(fs.readdirSync(path.dirname(Stacks.location(root))).some(name => name.startsWith("application-stacks.unreadable-")));
  const data = file(root);data.stacks["bundle:com.example.one"].effects = { schema: 99 };
  fs.writeFileSync(Stacks.location(root), JSON.stringify(data));
  assert.equal(Stacks.lookup(root, app("com.example.one")), null);
});

test("a window session starts from its app's stack and saves it when it ends", async t => {
  const root = library(t);
  const target = { kind: "application", pid: 9, name: "Example", bundleIdentifier: "com.example.app", path: "/Applications/Example.app" };
  const first = WindowActions.applyGraphics.createEntry(target, { userDataDir: root, gameId: "one" });
  assert.equal(first.effects, undefined, "the first session starts from the default stack");
  assert.equal(WindowActions.applyGraphics.endEntry({ ...first, effects: shader("crt"), runtimeSettings: { capture: { captureCursor: true } } }, { userDataDir: root }), "saved");
  const second = WindowActions.applyGraphics.createEntry({ ...target, pid: 10 }, { userDataDir: root, gameId: "two" });
  assert.equal(second.effects.video[0].id, "crt");
  assert.deepEqual(second.runtimeSettings, { capture: { captureCursor: true } });
  assert.equal(second.moduleData.pid, 10);
  const pruned = await WindowActions.applyGraphics.maintain({ userDataDir: root, windowGraphics: () => ({ available: true, executable: "/helper" }),
    installedApplications: async (ids, { executable }) => { assert.equal(executable, "/helper");return Object.fromEntries(ids.map(id => [id, false])); } });
  assert.deepEqual(pruned, ["bundle:com.example.app"]);
});
