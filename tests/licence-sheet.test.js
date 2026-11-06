const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const Sheet = require("../src/main/licence-sheet");

const plan = { kind: "licence", label: "Apple Game Porting Toolkit", component: "D3DMetal", message: "Agree to the Apple Game Porting Toolkit license?",
  detail: "APPLE INC.\nSOFTWARE LICENSE AGREEMENT <b>&</b>\n", licenseRequired: true, confirmLabel: "Agree and Import", cancelLabel: "Cancel" };
// A BrowserWindow stand-in that records its options and page and closes like a window.
function electron() {
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.shown = false; windows.push(this);
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: handler => { this.openHandler = handler; } });
    }
    loadURL(url) { this.url = url; queueMicrotask(() => this.emit("ready-to-show")); return Promise.resolve(); }
    show() { this.shown = true; }
    isDestroyed() { return this.destroyed; }
    close() { if (!this.destroyed) { this.destroyed = true; this.emit("closed"); } }
  }
  return { windows, BrowserWindow, nativeTheme: { shouldUseDarkColors: false }, systemPreferences: { getAccentColor: () => "0a84ffff" } };
}
const parent = { isDestroyed: () => false };
const navigate = (window, url) => { let prevented = false; window.webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, url); return prevented; };
const settle = async () => { for (let i = 0; i < 3; i += 1) await new Promise(resolve => setImmediate(resolve)); };

test("licence plans use the sheet and other consent plans keep the message box", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/main.js"), "utf8");
  const code = source.slice(source.indexOf("async function confirmRuntimeInstallation("), source.indexOf("\nfunction logRuntimeToolSpawn("));
  const sheets = [], boxes = [], owner = { id: "launcher" }, signal = new AbortController().signal;
  const context = { path, getLauncherDialogOwner: () => owner,
    require: name => { assert.equal(name, "./licence-sheet"); return { show: async (...args) => { sheets.push(args); return { approved: true, licenseAccepted: true }; } }; },
    dialog: { showMessageBox: async (...args) => { boxes.push(args); return { response: 0 }; } } };
  vm.createContext(context); vm.runInContext(code, context);
  assert.deepEqual(await context.confirmRuntimeInstallation(plan, null, { signal }), { approved: true, licenseAccepted: true });
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0][0], plan);
  assert.equal(sheets[0][1].parent, owner);
  assert.equal(sheets[0][1].signal, signal);
  for (const other of [{ kind: "prerequisite", detail: "Required." }, { requiresDownload: true, licenseRequired: true, detail: "Xcode terms apply." }])
    await context.confirmRuntimeInstallation(other, null);
  assert.equal(sheets.length, 1, "other plans, including those with a license URL, keep the message box");
  assert.equal(boxes.length, 2);
  assert.equal(await context.confirmRuntimeInstallation(plan, null, { signal: AbortSignal.abort() }), false);
  assert.equal(sheets.length, 1, "a superseded request opens nothing");
});

test("the sheet page shows the license as escaped text without scripts or remote content", () => {
  const html = Sheet.page(plan, "0a84ffff");
  assert.match(html, /<h1>Apple Game Porting Toolkit license<\/h1><p>Required to import D3DMetal\.<\/p>/);
  assert.match(html, /SOFTWARE LICENSE AGREEMENT &#60;b&#62;&#38;&#60;\/b&#62;/);
  assert.doesNotMatch(html, /<script|<b>|https?:/i);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /--accent: #0a84ffff/);
  // Cancel is the focused default, so Return does not agree.
  assert.ok(html.indexOf("autofocus>Cancel<") > 0 && html.indexOf("autofocus>Cancel<") < html.indexOf(">Agree and Import<"));
});

test("Agree resolves the consent contract and every other ending cancels", async () => {
  const cases = [
    [window => navigate(window, "maclauncher-licence:agree?"), { approved: true, licenseAccepted: true }],
    [window => navigate(window, "maclauncher-licence:cancel?"), false],
    [window => window.webContents.emit("before-input-event", { preventDefault() {} }, { type: "keyDown", key: "Escape" }), false],
    [window => window.close(), false]
  ];
  for (const [end, expected] of cases) {
    const fake = electron(), result = Sheet.show(plan, { parent, electron: fake });
    await settle();
    const [window] = fake.windows;
    assert.equal(window.shown, true);
    end(window);
    assert.deepEqual(await result, expected);
    assert.equal(window.destroyed, true, "the sheet closes with the choice");
  }
});

test("the sheet is a sandboxed modal sheet that loads only its own page", async () => {
  const fake = electron(), result = Sheet.show(plan, { parent, electron: fake });
  await settle();
  const [window] = fake.windows, { options } = window;
  assert.equal(options.parent, parent);
  assert.equal(options.modal, true);
  assert.deepEqual({ ...options.webPreferences }, { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false, devTools: false });
  assert.match(window.url, /^data:text\/html;charset=utf-8,/);
  assert.deepEqual(window.openHandler(), { action: "deny" });
  assert.equal(navigate(window, "https://example.com/"), true, "other navigation is prevented");
  assert.equal(window.destroyed, false, "and is not a choice");
  window.close();
  assert.equal(await result, false);
});

test("a superseded request closes the sheet as canceled", async () => {
  const fake = electron(), controller = new AbortController(), result = Sheet.show(plan, { parent, signal: controller.signal, electron: fake });
  await settle();
  controller.abort();
  assert.equal(await result, false);
  assert.equal(fake.windows[0].destroyed, true);
  assert.equal(await Sheet.show(plan, { parent, signal: AbortSignal.abort(), electron: fake }), false);
  assert.equal(fake.windows.length, 1, "an already superseded request opens no sheet");
});
