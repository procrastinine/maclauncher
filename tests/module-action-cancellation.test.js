const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createModuleActionRequests } = require("../src/main/module-action-requests");
const { createBackendOperations } = require("../src/core/backend-operations");
const { runToolCommand } = require("../src/modules/shared/runtime/tool-command");

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
class Owner extends EventEmitter {
  isDestroyed() { return this.destroyed === true; }
  destroy() { this.destroyed = true; this.emit("destroyed"); }
}
function fixture(t, actions, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-action-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const info = { id: "fixture", label: "Fixture" }, mod = { id: info.id, manifest: info, actions };
  const registry = { listModuleIds: () => [info.id], listModules: () => [info],
    getModule: () => mod, getModuleInfo: () => info, getModuleDir: () => root,
    listSharedRuntimeManagers: () => [], getRuntimeManagerUi: () => null };
  const operations = createBackendOperations({ userDataDir: path.join(root, "data"), registry, ...options });
  const requests = createModuleActionRequests({ request: (_lane, method, ...args) => operations[method](...args) });
  const entry = id => ({ gameId: id, gamePath: path.join(root, id), moduleId: info.id });
  return { root, operations, requests, entry };
}

test("inspector action cancellation isolates windows and stops the real tool before settling", { timeout: 10000 }, async t => {
  const processStarted = gate(), otherStarted = gate(), finishOther = gate();
  t.after(() => finishOther.resolve());
  let otherSignal;
  const env = fixture(t, {
    process: async (_entry, _payload, context) => {
      await runToolCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: env.root, logPath: path.join(env.root, "tool.log"), signal: context.signal,
        onSpawn: async child => { await context.onToolProcessSpawn(child); processStarted.resolve(child.pid); }
      });
      return { completed: true };
    },
    other: async (_entry, _payload, context) => {
      otherSignal = context.signal; otherStarted.resolve(); await finishOther.promise;
      return { completed: true };
    },
    legacy: (_entry, _payload, context) => ({ legacy: true, signal: context.signal })
  });
  const first = new Owner(), second = new Owner(), outsider = new Owner();
  const a = env.requests.run(first, "same-client-id", "game:a", [env.entry("a"), "process", {}, {}]);
  const rejected = assert.rejects(a, { name: "AbortError" });
  const b = env.requests.run(second, "same-client-id", "game:b", [env.entry("b"), "other", {}, {}]);
  const [pid] = await Promise.all([processStarted.promise, otherStarted.promise]);
  t.after(() => { try { process.kill(-pid, "SIGKILL"); } catch {} });
  assert.equal(await env.requests.cancel(outsider, "same-client-id"), false);
  await assert.rejects(env.requests.run(first, "same-client-id", "game:a", [env.entry("a"), "legacy", {}, {}]), /already running/);
  assert.equal(await env.requests.cancel(first, "same-client-id"), true);
  await rejected;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(otherSignal.aborted, false);
  assert.equal(first.listenerCount("destroyed"), 0);
  assert.equal(first.listenerCount("render-process-gone"), 0);
  assert.equal(await env.requests.cancel(first, "same-client-id"), false);
  finishOther.resolve(); assert.deepEqual(await b, { completed: true });
  assert.equal(second.listenerCount("destroyed"), 0);
  assert.equal(second.listenerCount("render-process-gone"), 0);
  assert.deepEqual(await env.operations.moduleAction(env.entry("legacy"), "legacy", {}, {}), { legacy: true, signal: undefined });
});

test("inspector action owner destruction and renderer failure abort only their own work", async t => {
  for (const event of ["destroyed", "render-process-gone"]) await t.test(event, async t => {
    const started = gate(); let signal;
    const env = fixture(t, { wait: async (_entry, _payload, context) => {
      signal = context.signal; started.resolve();
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    const owner = new Owner();
    const pending = env.requests.run(owner, "owned", "game:owned", [env.entry("owned"), "wait", {}, {}]);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await started.promise;
    if (event === "destroyed") owner.destroy(); else owner.emit(event);
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(owner.listenerCount("destroyed"), 0);
    assert.equal(owner.listenerCount("render-process-gone"), 0);
    assert.equal(await env.requests.cancel(owner, "owned"), false);
  });
});

test("inspector action cancellation is registered before asynchronous game admission", async t => {
  const admission = gate(); let calls = 0, releases = 0;
  const env = fixture(t, { wait: () => { calls++; return true; } }, {
    runtimeCoordinator: { acquireGameUse: () => admission.promise, release: async () => { releases++; } }
  });
  const pending = env.operations.moduleAction(env.entry("queued"), "wait", {}, {}, { requestId: "queued" });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  const canceled = env.operations.cancelModuleAction("queued");
  admission.resolve("game-admission");
  await rejected; assert.equal(await canceled, true);
  assert.equal(calls, 0); assert.equal(releases, 1);
  assert.equal(await env.operations.cancelModuleAction("queued"), false);
});

test("cancellable inspector actions show Cancel only while running and retain cancellation state", async () => {
  const React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
  const Module = require("node:module"), { build } = require("vite");
  const bundle = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "../src/renderer/src/ui/components/ModuleTools.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, "module-action-cancellation-ui.cjs"), module);
  compiled.paths = module.paths; compiled._compile(bundle.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  const render = (cancellable, busy, cancelling = false, onCancel = () => {}) => renderToStaticMarkup(React.createElement(compiled.exports.ModuleTools, {
    game: { gamePath: "/fixture" }, groups: [{ id: "tools", label: "Tools", actions: ["long"] }],
    actions: [{ id: "long", label: "Export", cancellable }], results: {}, busy: { long: busy },
    cancelling: { long: cancelling }, onAction() {}, onCancel
  }));
  assert.doesNotMatch(render(false, true), /Cancel/);
  assert.doesNotMatch(render(true, false), /Cancel/);
  assert.match(render(true, true), /aria-label="Cancel Export"[^>]*>Cancel<\/button>/);
  assert.match(render(true, true, true), /disabled="" aria-label="Cancel Export"[^>]*>Canceling…<\/button>/);
  assert.doesNotMatch(render(true, true, false, null), /Cancel/);
});
