const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const React = require("react");
const { build } = require("vite");

test("account panels read cached names on mount, focus and after actions; explicit refresh preserves rows", async () => {
  let hooks;
  const react = { ...React };
  for (const name of ["useState", "useRef", "useEffect", "useCallback"]) react[name] = (...args) => hooks[name](...args);
  const result = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "../src/renderer/src/ui/components/ModuleAccountsPanel.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, "module-accounts-panel.cjs"), module); compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(result.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  const slots = [], calls = [], listeners = {};
  let cursor, effects, finishRefresh;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  hooks = {
    useState(initial) { const index = cursor++; slots[index] ||= { value: typeof initial === "function" ? initial() : initial }; return [slots[index].value, value => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useCallback(callback, dependencies) { const index = cursor++; if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { value: callback, dependencies }; return slots[index].value; },
    useEffect(effect, dependencies) { const index = cursor++, previous = slots[index]; if (!previous || !same(previous.dependencies, dependencies)) { slots[index] = { dependencies }; effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); }); } }
  };
  const previousWindow = global.window, previousDocument = global.document;
  global.window = { addEventListener: (name, callback) => { listeners[name] = callback; }, removeEventListener: name => { delete listeners[name]; } };
  global.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  const descriptor = { label: "Google accounts", stateAction: "accounts.state", signInAction: "accounts.sign-in", signInLabel: "Sign in in browser", signInPayload: { mode: "browser" }, removeAction: "accounts.remove" };
  const cached = { accounts: [{ id: "account:one", label: "Saved account", canRemove: true }], canSignIn: true };
  const action = async (moduleId, name, payload) => { calls.push([moduleId, name, payload]); return payload?.refresh === true ? new Promise(resolve => { finishRefresh = resolve; }) : cached; };
  const render = () => { cursor = 0; effects = []; const tree = compiled.exports.ModuleAccountsPanel({ moduleId: "android", descriptor, action }); effects.forEach(effect => effect()); return tree; };
  const all = element => React.isValidElement(element) ? [element, ...React.Children.toArray(element.props.children).flatMap(all)] : [];
  const find = predicate => all(render()).find(predicate);
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)); render(); };
  try {
    render(); await settle();
    assert.deepEqual(calls, [["android", "accounts.state", { refresh: false }]]);
    listeners.focus(); await settle(); assert.deepEqual(calls.at(-1), ["android", "accounts.state", { refresh: false }]);
    find(node => node.props["aria-label"] === "Refresh accounts").props.onClick(); render();
    assert.deepEqual(calls.at(-1), ["android", "accounts.state", { refresh: true }]);
    assert.ok(find(node => node.type === "td" && node.props.children === "Saved account"));
    finishRefresh(cached); await settle();
    const browserSignIn = find(node => node.type === "button" && node.props.children === "Sign in in browser");
    assert.equal(browserSignIn.props.className, "btn primary");
    browserSignIn.props.onClick(); await settle(); await settle();
    assert.deepEqual(calls.find(call => call[1] === "accounts.sign-in"), ["android", "accounts.sign-in", { mode: "browser" }]);
    assert.deepEqual(calls.at(-1), ["android", "accounts.state", { refresh: false }]);
    assert.equal(calls.filter(call => call[2]?.refresh === true).length, 1);
  } finally { slots.forEach(slot => slot?.cleanup?.()); global.window = previousWindow; global.document = previousDocument; }
});
