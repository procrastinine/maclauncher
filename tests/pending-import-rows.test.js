const test = require("node:test"), assert = require("node:assert/strict");
const path = require("node:path");

test("a requested import has its library row before the launcher answers, and the row follows detection until the record arrives", async () => {
  const { runImportBatch } = await import("../src/renderer/src/ui/import-batch.mjs");
  const { pendingImportRows } = await import("../src/renderer/src/ui/pending-imports.mjs");
  const settle = {}, batches = [];
  const running = runImportBatch(["/games/Alpha Folder", "/games/beta.xapk"], input => new Promise((resolve, reject) => { settle[input] = { resolve, reject }; }),
    progress => { batches[0] = progress; });
  // Nothing from the launcher has arrived: no queue jobs, no game records.
  assert.deepEqual(pendingImportRows(batches, [], []).map(row => [row.name, row.phase, row.moduleId]),
    [["Alpha Folder", "queued", null], ["beta.xapk", "queued", null]], "both rows exist with their item names at once");
  const jobs = [{ inputPath: "/games/Alpha Folder", phase: "detected", name: "Alpha", moduleId: "godot" },
    { inputPath: "/games/beta.xapk", phase: "extracting", completed: 7, total: 4 }, { inputPath: "/menu/Gamma", phase: "processing" }];
  assert.deepEqual(pendingImportRows(batches, jobs, []).map(row => [row.name, row.phase, row.moduleId, row.completed, row.total]), [
    ["Alpha", "detected", "godot", undefined, undefined], ["beta.xapk", "extracting", null, 4, 4], ["Gamma", "processing", null, undefined, undefined]],
    "detection fills in the title and game type; imports started elsewhere have rows too");
  const games = [{ gamePath: "/games/Alpha Folder/Alpha.exe", importPath: "/games/Alpha Folder" }];
  assert.deepEqual(pendingImportRows(batches, jobs, games).map(row => row.inputPath), ["/games/beta.xapk", "/menu/Gamma"],
    "the row leaves when the game's record arrives");
  settle["/games/Alpha Folder"].resolve(); settle["/games/beta.xapk"].reject(new Error("Unreadable."));
  await running;
  assert.deepEqual(pendingImportRows(batches, [], games), [], "a finished or failed import has no row");
});

let component;
test.before(async () => {
  const { build } = require("vite"), Module = require("node:module");
  const result = await build({ configFile: false, logLevel: "silent", build: { ssr: path.join(__dirname, "../src/renderer/src/ui/components/PendingGameRow.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs" } } } });
  const compiled = new Module(path.join(__dirname, "pending-game-row.cjs"), module); compiled.paths = module.paths;
  const originalRequire = compiled.require.bind(compiled); compiled.require = id => id === "react" ? require("./helpers/renderer-component").react : originalRequire(id);
  compiled._compile(result.output.find(row => row.type === "chunk").code, compiled.id); component = compiled.exports;
});

test("a pending row shows its name, an empty icon tile, its game type once known, its progress and Cancel", () => {
  const React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
  const render = (row, moduleInfo = null) => renderToStaticMarkup(React.createElement(component.PendingGameRow,
    { row, moduleInfo, showIcons: true, withHandle: true, onCancel: () => {} }));
  const queued = render({ inputPath: "/games/Alpha Folder", name: "Alpha Folder", moduleId: null, phase: "queued" });
  assert.match(queued, /class="gameItem pendingImport"/); assert.match(queued, /aria-busy="true"/);
  assert.match(queued, />Alpha Folder</); assert.match(queued, /data-icon-source="pending"/); assert.match(queued, />Queued</);
  assert.doesNotMatch(queued, /class="badge"/); assert.match(queued, />Cancel</);
  const detected = render({ inputPath: "/games/Alpha Folder", name: "Alpha", moduleId: "godot", phase: "detected" }, { shortLabel: "Godot", label: "Godot Engine" });
  assert.match(detected, />Alpha</); assert.match(detected, /class="badge">Godot</); assert.match(detected, />Adding…</);
});
