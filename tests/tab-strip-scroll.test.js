const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { build } = require("vite");
let components;
test.before(async () => {
  const bundle = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "tab-strip-components.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, "tab-strip-components.cjs"), module);
  compiled.paths = module.paths;
  compiled._compile(bundle.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  components = compiled.exports;
});

function fixture(t, { width = 320, contentWidth = 1000 } = {}) {
  let observer;
  const previousObserver = global.ResizeObserver;
  global.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.observed = new Set(); this.removed = []; observer = this; }
    observe(element) { this.observed.add(element); }
    unobserve(element) { this.observed.delete(element); this.removed.push(element); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
    fire() { this.callback([]); }
  };
  const container = { clientWidth: width }, listeners = new Map(), states = [], scrolls = [];
  const viewport = { clientWidth: width, scrollWidth: contentWidth, scrollLeft: 0, scrollTop: 37,
    getBoundingClientRect: () => ({ left: 100, right: 100 + viewport.clientWidth }),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
    querySelectorAll: selector => { assert.equal(selector, '[role="tab"]'); return viewport.tabs; },
    scrollTo: options => { scrolls.push(options); viewport.scrollLeft = Math.max(0,
      Math.min(viewport.scrollWidth - viewport.clientWidth, options.left)); listeners.get("scroll")?.(); }
  };
  const tab = (id, left, size = 150) => ({ id,
    getBoundingClientRect: () => ({ left: 100 + left - viewport.scrollLeft, right: 100 + left + size - viewport.scrollLeft }) });
  viewport.tabs = [tab("first", 0), tab("middle", 400), tab("last", 850)];
  const controller = components.createTabStripScrollController(container, viewport, value => states.push(value));
  t.after(() => { controller.dispose(); global.ResizeObserver = previousObserver; });
  return { controller, container, viewport, observer, states, scrolls, listeners, tab };
}

test("overflow controls reflect both edges, fractional boundaries and horizontal overscroll", () => {
  const state = components.tabStripScrollState;
  assert.deepEqual(state({ clientWidth: 320, scrollWidth: 320, scrollLeft: 0 }),
    { overflow: false, canScrollLeft: false, canScrollRight: false });
  assert.deepEqual(state({ clientWidth: 320, scrollWidth: 1000, scrollLeft: -12 }),
    { overflow: true, canScrollLeft: false, canScrollRight: true });
  assert.deepEqual(state({ clientWidth: 320, scrollWidth: 1000, scrollLeft: 240 }),
    { overflow: true, canScrollLeft: true, canScrollRight: true });
  assert.deepEqual(state({ clientWidth: 320, scrollWidth: 1000, scrollLeft: 700 }),
    { overflow: true, canScrollLeft: true, canScrollRight: false });
  assert.equal(state({ clientWidth: 320, scrollWidth: 1000, scrollLeft: 679.5 }).canScrollRight, false);
  assert.equal(state({ clientWidth: 0, scrollWidth: 1000, scrollLeft: 0 }).overflow, false);
});

test("arrow clicks move only horizontally, clamp at each edge and preserve the selected tab", t => {
  const f = fixture(t);
  f.controller.update("first");
  f.controller.scroll(1);
  assert.equal(f.viewport.scrollLeft, 240);
  f.controller.scroll(1); f.controller.scroll(1); f.controller.scroll(1);
  assert.equal(f.viewport.scrollLeft, 680);
  assert.equal(f.states.at(-1).canScrollRight, false);
  const operations = f.scrolls.length;
  f.controller.update("first");
  assert.equal(f.scrolls.length, operations, "An unrelated React/state update never reselects or snaps back to the active tab");
  assert.equal(f.viewport.scrollLeft, 680);
  f.controller.scroll(-1); f.controller.scroll(-1); f.controller.scroll(-1);
  assert.equal(f.viewport.scrollLeft, 0);
  assert.equal(f.states.at(-1).canScrollLeft, false);
  assert.equal(f.viewport.scrollTop, 37);
  assert.ok(f.scrolls.every(options => !Object.hasOwn(options, "top")));
  assert.deepEqual(f.viewport.tabs.map(tab => tab.id), ["first", "middle", "last"]);
});

test("manual scrolling updates controls without changing selection or triggering another scroll", t => {
  const f = fixture(t);
  f.controller.update("first");
  f.viewport.scrollLeft = 120;
  f.listeners.get("scroll")();
  assert.equal(f.states.at(-1).canScrollLeft, true);
  assert.equal(f.states.at(-1).canScrollRight, true);
  assert.equal(f.scrolls.length, 0);
  f.controller.update("first");
  assert.equal(f.viewport.scrollLeft, 120);
  assert.equal(f.scrolls.length, 0);
});

test("a real active-tab change reveals that tab without scrolling any ancestor vertically", t => {
  const f = fixture(t);
  f.controller.update("first");
  f.controller.update("last");
  assert.equal(f.viewport.scrollLeft, 680);
  f.controller.update("middle");
  assert.equal(f.viewport.scrollLeft, 400);
  f.controller.update("first");
  assert.equal(f.viewport.scrollLeft, 0);
  assert.equal(f.viewport.scrollTop, 37);
  assert.ok(f.scrolls.every(options => options.behavior === "auto" && !Object.hasOwn(options, "top")));
});

test("widening hides unnecessary arrows even while their old gutters still reduce the viewport", t => {
  const f = fixture(t, { width: 600, contentWidth: 620 });
  f.controller.update("first");
  assert.equal(f.states.at(-1).overflow, true);
  f.viewport.clientWidth = 552;
  f.observer.fire();
  f.container.clientWidth = 650; f.viewport.clientWidth = 602;
  f.observer.fire();
  assert.deepEqual(f.states.at(-1), { overflow: false, canScrollLeft: false, canScrollRight: false });
  f.viewport.clientWidth = 650; f.viewport.scrollWidth = 650;
  f.observer.fire();
  assert.equal(f.states.at(-1).overflow, false);
});

test("a narrower window keeps the active tab visible while content-only changes preserve browsing", t => {
  const f = fixture(t, { width: 600 });
  f.controller.update("middle");
  assert.equal(f.viewport.scrollLeft, 0);
  f.container.clientWidth = 320; f.viewport.clientWidth = 272;
  f.observer.fire();
  assert.equal(f.viewport.scrollLeft, 278);
  f.viewport.scrollLeft = 600;
  f.listeners.get("scroll")();
  const operations = f.scrolls.length;
  f.viewport.scrollWidth = 1200;
  f.controller.update("middle");
  f.observer.fire();
  assert.equal(f.viewport.scrollLeft, 600);
  assert.equal(f.scrolls.length, operations, "An unchanged selection and width do not interrupt browsing");
});

test("new and removed tabs update overflow and observers, and cleanup ignores pending resize callbacks", t => {
  const f = fixture(t);
  f.controller.update("first");
  const removed = f.viewport.tabs.pop(), added = f.tab("new", 1100);
  f.viewport.tabs.push(added); f.viewport.scrollWidth = 1250;
  f.controller.update("new");
  assert.ok(f.observer.removed.includes(removed));
  assert.ok(f.observer.observed.has(added));
  assert.equal(f.viewport.scrollLeft, 930);
  const publications = f.states.length, operations = f.scrolls.length;
  f.controller.dispose();
  f.viewport.clientWidth = 100; f.observer.fire();
  f.controller.update("first"); f.controller.scroll(-1);
  assert.equal(f.states.length, publications);
  assert.equal(f.scrolls.length, operations);
  assert.equal(f.observer.disconnected, true);
  assert.equal(f.listeners.has("scroll"), false);
});

test("the shared component keeps arrow controls outside the real tablist with distinct accessible names", () => {
  const markup = renderToStaticMarkup(React.createElement(components.ScrollableTabStrip,
    { label: "Settings sections", selectedTabId: "tab-one", tabsClassName: "settingsTabs" },
    React.createElement("button", { role: "tab", id: "tab-one", "aria-selected": true, "aria-controls": "panel-one", tabIndex: 0 }, "One")));
  const list = markup.indexOf('role="tablist"'), tab = markup.indexOf('role="tab"');
  const left = markup.indexOf('aria-label="Scroll Settings sections left"'), right = markup.indexOf('aria-label="Scroll Settings sections right"');
  assert.ok(left < list && list < tab && tab < right);
  assert.equal((markup.match(/role="tablist"/g) || []).length, 1);
  assert.equal((markup.match(/role="tab"/g) || []).length, 1);
  assert.match(markup, /aria-label="Scroll Settings sections left"[^>]+hidden="" disabled=""/);
  assert.match(markup, /aria-label="Scroll Settings sections right"[^>]+hidden="" disabled=""/);
  assert.equal((markup.match(/width="14" height="14" aria-hidden="true" focusable="false"/g) || []).length, 2);
});
