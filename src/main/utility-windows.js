const { normalizeUtilityWindowRequest, utilityWindowDefinition } = require("../core/utility-window-model.mjs");

// Window construction and state delivery are injected; this controller also
// runs in plain Node and never owns a settings or runtime cache.
// Views in keptViews are prepared hidden ahead of use and hide when closed, so
// opening one shows a view that has already drawn its state. beforeShow
// brings a hidden window's state current just before it shows; onHidden runs
// after a close hides one. While isQuitting() is true they close normally.
function createUtilityWindowController({ createWindow, loadView, registerWindow = () => {}, onContextChange = () => {},
  keptViews = [], beforeShow = () => {}, onHidden = () => {}, isQuitting = () => false }) {
  const windows = new Map();
  const byWindow = new WeakMap();
  const kept = new Set(keptViews);
  let revision = 0;
  function context(request) { return { ...request, revision: ++revision }; }
  function forget(record) {
    if (windows.get(record.context.view) === record) windows.delete(record.context.view);
    byWindow.delete(record.win);
  }
  function focus(win,activate=true) {
    if (win.isDestroyed()) return null;
    const record = byWindow.get(win);
    if (record?.hidden) { record.hidden = false; beforeShow(win); }
    if (!activate) {win.showInactive();return win;}
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }
  function create(request, activate) {
    const win = createWindow({ ...utilityWindowDefinition(request.view), frame: true, modal: false, show: false }, request);
    const record = { win, context: context(request), ready: null, hidden: true };
    windows.set(request.view, record);
    byWindow.set(win, record);
    win.on("closed", () => forget(record));
    win.on("page-title-updated", event => event.preventDefault());
    if (kept.has(request.view)) win.on("close", event => {
      if (isQuitting() || win.isDestroyed()) return;
      event.preventDefault();
      record.hidden = true;
      win.hide();
      onHidden(win);
    });
    try {
      registerWindow(win, request.view,{activate});
      record.ready = Promise.resolve().then(() => loadView(win, request)).catch(error => {
        forget(record);
        if (!win.isDestroyed()) win.destroy();
        throw error;
      });
      return record;
    } catch (error) {
      forget(record);
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
  }

  async function open(value) {
    const {activate=true,...request} = normalizeUtilityWindowRequest(value);
    let record = windows.get(request.view);
    if (record?.win.isDestroyed()) { forget(record); record = null; }
    if (record) {
      if (request.managerId || request.sectionId || request.shaderCategory || request.moduleId) {
        record.context = context(request);
        // A hidden window receives it with its state just before it shows.
        if (!record.hidden) onContextChange(record.win);
      }
      await record.ready;
      return focus(record.win,activate);
    }
    record = create(request, activate);
    // A view opened before it was prepared shows its native frame at once in
    // its background color and draws with its first state, which the page
    // reads with its request; nothing is resent.
    record.hidden = false;
    focus(record.win,activate);
    await record.ready;
    return record.win;
  }

  // Loads each kept view not open yet in a hidden window, one at a time.
  async function prepare(views = [...kept]) {
    for (const view of views) {
      if (!kept.has(view) || windows.has(view)) continue;
      const record = create(normalizeUtilityWindowRequest({ view }), false);
      await record.ready.catch(() => {});
    }
  }
  function isHidden(win) { return Boolean(byWindow.get(win)?.hidden); }

  // Settings, Runtimes, Credits and the other utility views show no library
  // rows, so their state leaves out the games and their icon previews.
  function stateForWindow(win, state) {
    const request = byWindow.get(win)?.context;
    return request && state ? { ...state, recents: [], utilityWindow: { ...request } } : state;
  }
  return { open, prepare, isHidden, stateForWindow };
}

module.exports = { createUtilityWindowController };
