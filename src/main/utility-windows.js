const { normalizeUtilityWindowRequest, utilityWindowDefinition } = require("../core/utility-window-model.mjs");

// Window construction and state delivery are injected; this controller also
// runs in plain Node and never owns a settings or runtime cache.
//
// Each view has at most one window. For the views in keptViews (Settings,
// Runtimes and Credits) the controller keeps at most one hidden window, the
// spare: prepared ahead of use, or the window of the view closed last. Opening
// that view shows the spare as it is; opening another kept view switches the
// spare to it: adaptWindow sets its title and size, and present() displays
// the view the page already holds and shows the window after its DOM acknowledgement.
// The hidden window receives every state like any other, so nothing renders
// on open; a request that navigates within a view (a section or runtime) is
// sent with beforeShow and drawn before the window shows. A new spare is
// prepared as soon as a loaded spare is taken. Each different requested view
// owns its window; a request during refill takes only the hidden spare.
// Closing a kept view hides its window at once; it becomes the spare, or, when
// a spare exists already, it is destroyed in idle time. While isQuitting() is
// true windows close normally. onHidden runs after a close hides a window.
function createUtilityWindowController({ createWindow, loadView, registerWindow = () => {}, onContextChange = () => {},
  keptViews = [], adaptWindow = () => {}, beforeShow = () => {}, present = null, onHidden = () => {},
  isQuitting = () => false, idle = callback => setImmediate(callback) }) {
  const windows = new Map();
  const byWindow = new WeakMap();
  const kept = new Set(keptViews);
  let revision = 0, spare = null;
  function context(request) { return { ...request, revision: ++revision }; }
  function forget(record) {
    if (windows.get(record.context.view) === record) windows.delete(record.context.view);
    if (spare === record) spare = null;
    byWindow.delete(record.win);
  }
  function focus(win,activate=true) {
    if (win.isDestroyed()) return null;
    if (!activate) {win.showInactive();return win;}
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }
  function create(request, activate) {
    const win = createWindow({ ...utilityWindowDefinition(request.view), frame: true, modal: false, show: false }, request);
    const record = { win, context: context(request), ready: null, loaded: false, hidden: true, shown: false, retiring: false };
    windows.set(request.view, record);
    byWindow.set(win, record);
    win.on("closed", () => forget(record));
    win.on("page-title-updated", event => event.preventDefault());
    if (kept.has(request.view)) win.on("close", event => {
      if (isQuitting() || win.isDestroyed()) return;
      event.preventDefault();
      if (record.hidden || record.retiring) return;
      win.hide();
      if (spare && spare !== record && !spare.win.isDestroyed()) {
        // One hidden window is enough; this one goes once the event loop is idle.
        record.retiring = true;
        if (windows.get(record.context.view) === record) windows.delete(record.context.view);
        idle(() => { if (!win.isDestroyed()) win.destroy(); });
      } else {
        record.hidden = true;
        spare = record;
      }
      onHidden(win);
    });
    try {
      registerWindow(win, request.view,{activate});
      record.ready = Promise.resolve().then(() => loadView(win, request)).then(() => { record.loaded = true; }, error => {
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

  // A taken page keeps its view. Cold pages show after their lightweight shell paints.
  async function reveal(record, activate, switched, navigation) {
    if (spare === record) spare = null;
    record.hidden = false;
    // A prepared page refills immediately; a cold page first presents its shell.
    const wasLoaded = record.loaded;
    if (wasLoaded) void ensureSpare();
    const { win } = record;
    if (!record.loaded) {
      await record.ready;
      if (switched && !navigation) onContextChange(win);
    }
    if (navigation) beforeShow(win);
    if (present) await present(win, { view: record.context.view, revision: record.context.revision, switched, navigation, shown: record.shown, activate });
    else focus(win, activate);
    record.shown = true;
    if (!wasLoaded) void ensureSpare();
    return win;
  }

  async function open(value) {
    const {activate=true,...request} = normalizeUtilityWindowRequest(value);
    let record = windows.get(request.view);
    if (record?.win.isDestroyed()) { forget(record); record = null; }
    const navigation = Boolean(request.managerId || request.sectionId || request.shaderCategory || request.moduleId);
    if (record?.revealing) { await record.revealing; record = windows.get(request.view) || record; }
    if (record && !record.hidden) {
      if (navigation) { record.context = context(request); onContextChange(record.win); }
      await record.ready;
      const win = focus(record.win,activate);
      record.shown = true;
      return win;
    }
    let switched = false;
    // A spare still loading is already partway: it takes this view once loaded.
    if (!record && kept.has(request.view) && spare && !spare.win.isDestroyed()) {
      // The spare takes this view: its previous view no longer has a window.
      record = spare;
      if (windows.get(record.context.view) === record) windows.delete(record.context.view);
      record.context = context(request);
      windows.set(request.view, record);
      adaptWindow(record.win, utilityWindowDefinition(request.view), request);
      switched = true;
    } else if (record && navigation) record.context = context(request);
    if (record) {
      const revealing = reveal(record, activate, switched, navigation);
      record.revealing = revealing;
      try { return await revealing; }
      finally { if (record.revealing === revealing) record.revealing = null; }
    }
    record = create(request, activate);
    record.hidden = false;
    if (kept.has(request.view)) {
      await record.ready;
      if (present) await present(record.win, {view: request.view, revision: record.context.revision, switched: false, navigation: false, shown: false, activate});
      else focus(record.win, activate);
    } else {
      focus(record.win, activate);
      await record.ready;
    }
    record.shown = true;
    void ensureSpare();
    return record.win;
  }

  // One hidden window for a kept view that has none, loaded once.
  async function ensureSpare() {
    if (isQuitting() || (spare && !spare.win.isDestroyed())) return;
    const view = [...kept].find(item => !windows.has(item));
    if (!view) return;
    const record = create(normalizeUtilityWindowRequest({ view }), false);
    spare = record;
    await record.ready.catch(() => {});
  }
  function isHidden(win) { const record = byWindow.get(win); return Boolean(record?.hidden || record?.retiring); }
  function isRetiring(win) { return Boolean(byWindow.get(win)?.retiring); }

  // Settings, Runtimes, Credits and the other utility views show no library
  // rows, so their state leaves out the games and their icon previews.
  function stateForWindow(win, state) {
    const request = byWindow.get(win)?.context;
    return request && state ? { ...state, recents: [], utilityWindow: { ...request } } : state;
  }
  return { open, prepare: ensureSpare, isHidden, isRetiring, stateForWindow };
}

module.exports = { createUtilityWindowController };
