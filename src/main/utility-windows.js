const { normalizeUtilityWindowRequest, utilityWindowDefinition } = require("../core/utility-window-model.mjs");

// Window construction and state delivery are injected; this controller also
// runs in plain Node and never owns a settings or runtime cache.
function createUtilityWindowController({ createWindow, loadView, registerWindow = () => {}, onContextChange = () => {} }) {
  const windows = new Map();
  const byWindow = new WeakMap();
  let revision = 0;
  function context(request) { return { ...request, revision: ++revision }; }
  function forget(record) {
    if (windows.get(record.context.view) === record) windows.delete(record.context.view);
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

  async function open(value) {
    const {activate=true,...request} = normalizeUtilityWindowRequest(value);
    let record = windows.get(request.view);
    if (record?.win.isDestroyed()) { forget(record); record = null; }
    if (record) {
      if (request.managerId || request.sectionId || request.shaderCategory || request.moduleId) {
        record.context = context(request);
        onContextChange(record.win);
      }
      await record.ready;
      return focus(record.win,activate);
    }
    const win = createWindow({ ...utilityWindowDefinition(request.view), frame: true, modal: false, show: false }, request);
    record = { win, context: context(request), ready: null };
    windows.set(request.view, record);
    byWindow.set(win, record);
    win.on("closed", () => forget(record));
    win.on("page-title-updated", event => event.preventDefault());
    try {
      registerWindow(win, request.view,{activate});
      record.ready = Promise.resolve().then(() => loadView(win, request)).catch(error => {
        forget(record);
        if (!win.isDestroyed()) win.destroy();
        throw error;
      });
      // The native frame shows at once in its background color, and the view
      // fills in as it loads. The new page reads its request with its first
      // state; nothing is resent.
      focus(win,activate);
      await record.ready;
      return win;
    } catch (error) {
      forget(record);
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
  }

  // Settings, Runtimes, Credits and the other utility views show no library
  // rows, so their state leaves out the games and their icon previews.
  function stateForWindow(win, state) {
    const request = byWindow.get(win)?.context;
    return request && state ? { ...state, recents: [], utilityWindow: { ...request } } : state;
  }
  return { open, stateForWindow };
}

module.exports = { createUtilityWindowController };
