const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { hasPublisherWindowSize, initialCanvasFit } = require("../src/modules/shared/web/preload/canvas-window");

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
function element(tagName, bounds, { style = {}, children = [], text, textBounds, tabIndex = -1 } = {}) {
  const node = {
    tagName: tagName.toUpperCase(), parentElement: null, style, childNodes: [], tabIndex,
    getBoundingClientRect: () => bounds,
    getClientRects: () => bounds.width && bounds.height ? [bounds] : [],
    contains(other) { return this.childNodes.some(child => child === other || child.contains?.(other)); },
    append(child) { child.parentElement = this; this.childNodes.push(child); return child; }
  };
  if (text) node.append({ nodeType: 3, textContent: text, rects: [textBounds || bounds] });
  for (const child of children) node.append(child);
  return node;
}
function page(children) {
  const body = element("body", rect(0, 0, 1100, 700), { children });
  const all = () => {
    const result = [];
    const walk = node => { if (!node.tagName) return; result.push(node); node.childNodes.forEach(walk); };
    walk(body);
    return result;
  };
  return {
    body, documentElement: body, readyState: "complete",
    defaultView: { getComputedStyle: node => node.style },
    querySelectorAll: selector => all().filter(node => selector === "*" || node.tagName === selector.toUpperCase()),
    createRange() { let node; return { selectNodeContents(value) { node = value; }, getClientRects: () => node.rects, detach() {} }; }
  };
}
const canvas = (bounds = rect(0, 0, 816, 624), options) => element("canvas", bounds, options);

test("single-canvas games retain natural fit with wrappers and controls over the canvas", () => {
  const surface = canvas();
  const overlay = element("button", rect(740, 12, 60, 30), { text: "Menu" });
  const wrapper = element("div", rect(0, 0, 1100, 700), { children: [surface, overlay], text: "Score", textBounds: rect(10, 10, 50, 20) });
  assert.deepEqual(initialCanvasFit(page([wrapper])), { canvas: surface, width: 816, height: 624 });
});

test("multiple rendered canvases prevent fitting, including a small secondary surface", () => {
  for (const second of [canvas(rect(850, 0, 200, 200)), canvas(rect(0, 0, 10, 10))]) {
    assert.equal(initialCanvasFit(page([canvas(), second])), null);
  }
});

test("hidden and zero-size canvases do not displace the sole visible canvas", () => {
  const surface = canvas();
  const hidden = element("div", rect(0, 0, 1100, 700), { style: { display: "none" }, children: [canvas()] });
  const document = page([hidden, canvas(rect(0, 0, 0, 0)), surface]);
  assert.equal(initialCanvasFit(document).canvas, surface);
  hidden.style.display = "block";
  assert.equal(initialCanvasFit(document), null);
});

test("visible text, media and interactive controls beyond the canvas preserve the page viewport", () => {
  for (const extra of [
    element("p", rect(0, 630, 300, 30), { text: "Status and settings" }),
    element("button", rect(780, 590, 100, 40)),
    element("input", rect(850, 0, 200, 30)),
    element("img", rect(0, 630, 100, 40)),
    element("div", rect(0, 630, 100, 40), { tabIndex: 0 }),
    element("div", rect(0, 630, 100, 40), { style: { backgroundImage: "url(panel.png)" } })
  ]) assert.equal(initialCanvasFit(page([canvas(), extra])), null, extra.tagName);
});

test("invisible content does not block fit but explicitly visible descendants still do", () => {
  const controls = element("div", rect(0, 630, 100, 40), {
    style: { opacity: "0" }, children: [element("button", rect(0, 630, 100, 40))]
  });
  assert.ok(initialCanvasFit(page([canvas(), controls])));
  controls.style = { visibility: "hidden" };
  controls.childNodes[0].style = { visibility: "visible" };
  assert.equal(initialCanvasFit(page([canvas(), controls])), null);
});

test("publisher window dimensions take precedence over canvas fit", () => {
  for (const window of [{ width: 960, height: 540 }, { width: "1200" }, { height: 700 }]) {
    assert.equal(hasPublisherWindowSize({ window }), true);
    assert.equal(initialCanvasFit(page([canvas()]), { window }), null);
  }
  for (const window of [{ width: 0 }, { width: "" }, { height: "auto" }, {}]) {
    assert.equal(hasPublisherWindowSize({ window }), false);
    assert.ok(initialCanvasFit(page([canvas()]), { window }));
  }
});

// Run the actual preload function with a deterministic DOM/timer boundary.
// This checks the delayed IPC decision, beyond the synchronous layout policy.
function install(document, manifest = null) {
  const source = fs.readFileSync(path.join(__dirname, "../src/modules/shared/web/preload/game.js"), "utf8");
  const start = source.indexOf("function installInitialCanvasResize()"), end = source.indexOf("\ninstallInitialCanvasResize();", start);
  const timers = new Map(), sends = [], observers = [];
  let timerId = 0;
  class Observer {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const scope = {
    document, manifest, initialCanvasFit, hasPublisherWindowSize,
    window: { innerWidth: 1100, innerHeight: 700 },
    ipcRenderer: { send: (...args) => sends.push(args) },
    ResizeObserver: Observer, MutationObserver: Observer,
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id)
  };
  vm.runInNewContext(source.slice(start, end) + "\ninstallInitialCanvasResize();", scope);
  return { sends, timers, observers, commit() {
    const timer = [...timers.values()].find(value => value.delay === 200);
    assert.ok(timer, "single canvas scheduled an initial fit");
    timer.callback();
  } };
}

test("actual preload performs one natural-size IPC resize and releases startup observers", () => {
  const result = install(page([canvas()]));
  result.commit();
  assert.equal(result.sends.length, 1);
  assert.deepEqual(result.sends[0].slice(0, 3), ["maclauncher:window:resizeTo", 816, 624]);
  assert.equal(result.sends[0][3].mode, "content");
  assert.equal(result.timers.size, 0);
  assert.ok(result.observers.every(observer => observer.disconnected));
});

test("delayed preload commit rejects a late second canvas or outside control", () => {
  for (const extra of [canvas(rect(0, 0, 400, 300)), element("button", rect(0, 630, 100, 40))]) {
    const document = page([canvas()]), result = install(document);
    document.body.append(extra);
    result.commit();
    assert.deepEqual(result.sends, []);
  }
});

test("publisher dimensions bypass automatic fit and all its observers", () => {
  const result = install(page([canvas()]), { window: { width: 1100, height: 700 } });
  assert.equal(result.observers.length, 0);
  assert.equal(result.timers.size, 0);
  assert.equal(result.sends.length, 0);
});
