// The window of an app action with a picker: the module streams sections of
// targets, optionally grouped, and thumbnails; choosing a target starts its
// session through the same path as a menu choice. One picker runs at a time,
// only while its window is open. Icons named by path are resolved here, so
// modules send paths or small images and the window receives images. Plain Node; the
// window, icon lookup and delivery are injected.
const LIMITS = Object.freeze({ sections: 8, targets: 256, searchTargets: 2048, label: 256, thumbnailBytes: 512 * 1024 });
const text = (value, limit = LIMITS.label) => typeof value === "string" && value.length > 0 ? value.slice(0, limit) : null;
const validId = value => typeof value === "string" && /^[A-Za-z0-9:_.-]{1,128}$/.test(value);
const absolute = value => typeof value === "string" && value.startsWith("/") && !value.includes("\0");
// A module may send an icon itself, as a small PNG or JPEG data URL.
const image = value => typeof value === "string" && value.length <= 128 * 1024 && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value);

// The module's model, bounded. Targets keep their module data for choose();
// the window receives everything except that data.
// A searchOnly target appears only while the window's search matches it.
// Shown and searchOnly targets have separate caps, LIMITS.targets and LIMITS.searchTargets.
const searchOnlyCaps = (counts = { shown: 0, searchOnly: 0 }) => target => target.searchOnly === true ? counts.searchOnly++ < LIMITS.searchTargets : counts.shown++ < LIMITS.targets;
function normalizeModel(model) {
  const sections = (Array.isArray(model?.sections) ? model.sections : []).filter(section => validId(section?.id)).slice(0, LIMITS.sections).map(section => ({
    id: section.id, label: text(section.label) || "", ...(text(section.empty) ? { empty: text(section.empty) } : {}),
    targets: (Array.isArray(section.targets) ? section.targets : []).filter(target => validId(target?.id) && text(target.label)).filter(searchOnlyCaps()).map(target => ({
      id: target.id, label: text(target.label), ...(text(target.detail) ? { detail: text(target.detail) } : {}),
      ...(image(target.icon) ? { icon: target.icon } : absolute(target.iconPath) ? { iconPath: target.iconPath } : {}), ...(target.preview === true ? { preview: true } : {}),
      ...(target.searchOnly === true ? { searchOnly: true } : {}),
      ...(Array.isArray(target.previews) ? { previews: target.previews.filter(validId).slice(0, 16) } : {}),
      ...(validId(target.group?.id) && text(target.group.label) ? { group: { id: target.group.id, label: text(target.group.label),
        ...(image(target.group.icon) ? { icon: target.group.icon } : absolute(target.group.iconPath) ? { iconPath: target.group.iconPath } : {}) } } : {}),
      target: target.target ?? null }))
  }));
  const notice = text(model?.notice?.message, 1024) ? { message: text(model.notice.message, 1024),
    ...(text(model.notice.link?.label) && /^(?:x-apple\.systempreferences|https):/.test(model.notice.link.url || "")
      ? { link: { label: text(model.notice.link.label), url: model.notice.link.url } } : {}) } : null;
  return { sections, ...(notice ? { notice } : {}), refreshOnFocus: model?.refreshOnFocus === true };
}

function createAppActionPicker({ appActions, targetContext = () => ({}), iconFor = async () => null, send = () => {}, choose, logger = console }) {
  let session = null, stopping = null;
  const icons = new Map(), chosen = new WeakSet();
  async function icon(file) {
    if (!file) return null;
    if (!icons.has(file)) {
      icons.set(file, Promise.resolve().then(() => iconFor(file)).catch(() => null));
      if (icons.size > 256) icons.delete(icons.keys().next().value);
    }
    return icons.get(file);
  }
  // What the window shows: sections with resolved icons, the notice and the
  // current thumbnails.
  async function view(current) {
    const sections = await Promise.all(current.model.sections.map(async section => ({ ...section,
      targets: await Promise.all(section.targets.map(async ({ target: _target, iconPath, group, ...item }) => {
        const resolved = item.icon || await icon(iconPath), groupImage = group ? group.icon || await icon(group.iconPath) : null;
        return { ...item, ...(resolved ? { icon: resolved } : {}),
          ...(group ? { group: { id: group.id, label: group.label, ...(groupImage ? { icon: groupImage } : {}) } } : {}) };
      })) })));
    const { link, ...notice } = current.model.notice || {};
    return { title: current.title, sections, thumbnails: { ...current.thumbnails },
      ...(current.model.notice ? { notice: { ...notice, ...(link ? { link: { label: link.label } } : {}) } } : {}) };
  }
  async function publish(current) {
    const serial = ++current.serial, payload = await view(current);
    if (session === current && serial === current.serial) send(current.win, { model: payload });
  }
  function begin(current) {
    if (stopping) {
      void stopping.then(() => { if (session === current) begin(current); }).catch(error => logger.warn?.("[app actions] The picker could not restart:", error.message));
      return;
    }
    if (session !== current) return;
    current.watch = appActions.watchPicker(current.moduleId, current.actionId, targetContext(current.moduleId), update => {
      if (session !== current) return;
      if (update?.sections) {
        current.model = normalizeModel(update);
        const ids = new Set(current.model.sections.flatMap(section => section.targets.map(target => target.id)));
        for (const id of Object.keys(current.thumbnails)) if (!ids.has(id)) delete current.thumbnails[id];
        void publish(current).catch(error => logger.warn?.("[app actions] The picker could not be shown:", error.message));
      }
      if (update?.thumbnails && typeof update.thumbnails === "object") {
        const changed = Object.fromEntries(Object.entries(update.thumbnails).filter(([id, image]) =>
          validId(id) && typeof image === "string" && image.startsWith("data:image/") && image.length <= LIMITS.thumbnailBytes));
        if (!Object.keys(changed).length) return;
        Object.assign(current.thumbnails, changed);
        send(current.win, { thumbnails: changed });
      }
    });
  }
  // Starts the picker for an open window, or keeps the running one.
  function start(win, moduleId, actionId) {
    if (session?.win === win && session.moduleId === moduleId && session.actionId === actionId) return session;
    stop();chosen.delete(win);
    const current = session = { win, moduleId, actionId, title: appActions.title(moduleId, actionId), model: normalizeModel(null),
      thumbnails: {}, serial: 0, watch: null };
    begin(current);
    return current;
  }
  function endWatch(current) {
    const watch = current.watch;current.watch = null;
    const result = watch?.stop();
    if (result?.then) {
      const pending = Promise.all([stopping, result]);
      stopping = pending;
      void pending.then(() => { if (stopping === pending) stopping = null; }, () => { if (stopping === pending) stopping = null; });
    }
    return stopping || Promise.resolve();
  }
  // Resolves when the module's picker processes have ended.
  function stop(win = null) {
    if (!session || (win && session.win !== win)) return stopping || Promise.resolve();
    const current = session;session = null;
    return endWatch(current);
  }
  // Refocusing presents the current model and keeps the existing catalog. A
  // model that marks itself incomplete, such as one waiting for a
  // permission, starts the module's picker again once its processes end.
  function focus(win) {
    if (session?.win !== win) return;
    const current = session;
    if (current.model.refreshOnFocus) {
      // Until the restarted picker reports, refocusing only presents.
      current.model = { ...current.model, refreshOnFocus: false };
      void endWatch(current).then(() => { if (session === current && !current.watch) begin(current); })
        .catch(error => logger.warn?.("[app actions] The picker could not restart:", error.message));
      return;
    }
    void publish(current).catch(error => logger.warn?.("[app actions] The picker could not be shown:", error.message));
  }
  // Ends the open picker's processes and resolves once they have ended;
  // resume() starts the picker again. A session that starts in between then
  // supplies the list, and never runs beside the picker's own processes.
  async function pause() {
    const current = session;
    if (!current) return () => {};
    await endWatch(current);
    return () => { if (session === current && !current.watch) begin(current); };
  }
  async function state(win) { return session?.win === win ? view(session) : null; }
  // The chosen target's session starts after the picker window closes and
  // the picker's processes have ended.
  // A second click on a window that already chose, as in a double-click,
  // does nothing.
  async function chooseTarget(win, targetId) {
    const current = session?.win === win ? session : null;
    if (!current && chosen.has(win)) return false;
    const target = current?.model.sections.flatMap(section => section.targets).find(item => item.id === targetId);
    if (!target) throw new Error("This choice is no longer available.");
    chosen.add(win);
    const stopped = stop(win);
    try { win.close?.(); } catch {}
    await stopped;
    await choose(current.moduleId, current.actionId, target);
    return true;
  }
  function link(win) { return session?.win === win ? session.model.notice?.link?.url || null : null; }
  return { start, stop, focus, pause, state, choose: chooseTarget, link };
}

module.exports = { createAppActionPicker, normalizeModel };
