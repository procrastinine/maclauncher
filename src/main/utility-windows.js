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
  function focus(win) {
    if (win.isDestroyed()) return null;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }

  async function open(value) {
    const request = normalizeUtilityWindowRequest(value);
    let record = windows.get(request.view);
    if (record?.win.isDestroyed()) { forget(record); record = null; }
    if (record) {
      if (request.managerId || request.sectionId) {
        record.context = context(request);
        onContextChange(record.win);
      }
      await record.ready;
      return focus(record.win);
    }
    const win = createWindow({ ...utilityWindowDefinition(request.view), frame: true, modal: false, show: false }, request);
    record = { win, context: context(request), ready: null };
    windows.set(request.view, record);
    byWindow.set(win, record);
    win.on("closed", () => forget(record));
    win.on("page-title-updated", event => event.preventDefault());
    try {
      registerWindow(win, request.view);
      record.ready = Promise.resolve().then(() => loadView(win, request)).catch(error => {
        forget(record);
        if (!win.isDestroyed()) win.destroy();
        throw error;
      });
      await record.ready;
      onContextChange(win);
      return focus(win);
    } catch (error) {
      forget(record);
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
  }

  function stateForWindow(win, state) {
    const request = byWindow.get(win)?.context;
    return request && state ? { ...state, utilityWindow: { ...request } } : state;
  }
  return { open, stateForWindow };
}

module.exports = { createUtilityWindowController };
