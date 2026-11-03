const assert = require("node:assert/strict");
const test = require("node:test");
const { createAppActionPicker, normalizeModel } = require("../src/main/app-action-picker");

function fixture() {
  const sent = [], chosen = [], watches = [];
  const appActions = {
    title: () => "Apply Graphics",
    watchPicker: (moduleId, actionId, context, update) => {
      const watch = { moduleId, actionId, context, update, stopped: false };
      watches.push(watch);
      return { stop: () => { watch.stopped = true; } };
    }
  };
  const picker = createAppActionPicker({ appActions, targetContext: moduleId => ({ moduleId }),
    iconFor: async file => "data:image/png;base64," + Buffer.from(file).toString("base64"),
    send: (win, payload) => sent.push([win, payload]), choose: async (...args) => chosen.push(args) });
  const win = { closed: 0, close() { this.closed++; } };
  return { sent, chosen, watches, picker, win };
}
const model = {
  sections: [
    { id: "displays", label: "Displays", targets: [{ id: "display:1", label: "Built-in Retina Display", preview: true, target: { kind: "display", displayID: 1 } }] },
    { id: "windows", label: "Windows", targets: [{ id: "window:4", label: "Document", group: { id: "application:9", label: "Example", iconPath: "/Applications/Example.app" },
      target: { kind: "window", windowID: 4 } }] }
  ],
  notice: { message: "Previews need a permission.", link: { label: "Open Privacy Settings", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" } }
};
const settle = () => new Promise(resolve => setImmediate(resolve));

test("the picker window receives sections with icons and thumbnails, without module data", async () => {
  const f = fixture();
  f.picker.start(f.win, "window", "applyGraphics");
  f.picker.start(f.win, "window", "applyGraphics");
  assert.equal(f.watches.length, 1, "reopening keeps the running picker");
  assert.deepEqual(f.watches[0].context, { moduleId: "window" });
  f.watches[0].update(model);await settle();
  const [, { model: shown }] = f.sent.at(-1);
  assert.equal(shown.title, "Apply Graphics");
  assert.equal(shown.sections[1].targets[0].group.icon, "data:image/png;base64," + Buffer.from("/Applications/Example.app").toString("base64"));
  assert.equal(JSON.stringify(shown).includes("windowID"), false, "module data stays in the main process");
  assert.deepEqual(shown.notice, { message: "Previews need a permission.", link: { label: "Open Privacy Settings" } });
  f.watches[0].update({ thumbnails: { "window:4": "data:image/jpeg;base64,AAAA", "window:99": "data:image/jpeg;base64,BBBB", "bad id!": "data:image/jpeg;base64,CC" } });
  assert.deepEqual(f.sent.at(-1)[1], { thumbnails: { "window:4": "data:image/jpeg;base64,AAAA", "window:99": "data:image/jpeg;base64,BBBB" } });
  assert.deepEqual((await f.picker.state(f.win)).thumbnails, { "window:4": "data:image/jpeg;base64,AAAA", "window:99": "data:image/jpeg;base64,BBBB" });
  f.watches[0].update(model);await settle();
  assert.deepEqual((await f.picker.state(f.win)).thumbnails, { "window:4": "data:image/jpeg;base64,AAAA" }, "thumbnails of targets that left are dropped");
  assert.equal(await f.picker.state({}), null, "another window sees no picker");
  assert.equal(f.picker.link(f.win), model.notice.link.url);
});

test("choosing a target closes the window, stops the list and starts the session", async () => {
  const f = fixture();
  f.picker.start(f.win, "window", "applyGraphics");
  f.watches[0].update(model);await settle();
  await assert.rejects(f.picker.choose(f.win, "window:missing"), /no longer available/);
  assert.equal(await f.picker.choose(f.win, "window:4"), true);
  assert.equal(f.win.closed, 1);
  assert.equal(f.watches[0].stopped, true);
  assert.deepEqual(f.chosen.map(([moduleId, actionId, target]) => [moduleId, actionId, target.id, target.target]),
    [["window", "applyGraphics", "window:4", { kind: "window", windowID: 4 }]]);
  f.watches[0].update(model);await settle();
  assert.equal(f.sent.filter(([, payload]) => payload.model).length, 1, "a stopped picker sends nothing");
  assert.equal(await f.picker.choose(f.win, "window:4"), false, "a second click, as in a double-click, does nothing");
  assert.equal(f.chosen.length, 1);
});

test("the chosen session starts only after the picker's processes have ended", async () => {
  const f = fixture();let ended;
  f.appActionsStop = new Promise(resolve => { ended = resolve; });
  const picker = createAppActionPicker({ appActions: { title: () => "Apply Graphics",
    watchPicker: (moduleId, actionId, context, update) => { f.watches.push({ update });return { stop: () => f.appActionsStop }; } },
  choose: async (...args) => f.chosen.push(args) });
  picker.start(f.win, "window", "applyGraphics");
  f.watches[0].update(model);await settle();
  const choosing = picker.choose(f.win, "window:4");
  await settle();
  assert.deepEqual([f.win.closed, f.chosen.length], [1, 0], "the window closes at once and the session waits for the catalog to exit");
  ended();
  assert.equal(await choosing, true);
  assert.equal(f.chosen.length, 1);
});

test("refocusing an incomplete list starts the module's picker again after its processes end", async () => {
  const f = fixture();
  f.picker.start(f.win, "window", "applyGraphics");
  f.watches[0].update({ ...model, refreshOnFocus: true });await settle();
  f.picker.focus(f.win);await settle();
  assert.deepEqual([f.watches.length, f.watches[0].stopped], [2, true]);
  f.picker.focus(f.win);await settle();
  assert.equal(f.watches.length, 2, "refocusing before the restarted picker reports does not restart it again");
  f.watches[1].update(model);await settle();
  f.picker.focus(f.win);await settle();
  assert.equal(f.watches.length, 2, "the complete list that replaced it is kept");
  f.picker.stop(f.win);
});

test("refocusing reuses the catalog and keeps its model and thumbnails until closing", async () => {
  const f = fixture();
  f.picker.start(f.win, "window", "applyGraphics");
  f.picker.focus(f.win);
  assert.equal(f.watches.length, 1, "a complete list is not restarted");
  f.watches[0].update(model);await settle();
  f.watches[0].update({ thumbnails: { "window:4": "data:image/jpeg;base64,AAAA" } });
  f.picker.focus(f.win);await settle();
  assert.deepEqual([f.watches.length, f.watches[0].stopped], [1, false]);
  assert.equal((await f.picker.state(f.win)).sections[0].targets[0].id, "display:1");
  assert.deepEqual((await f.picker.state(f.win)).thumbnails, { "window:4": "data:image/jpeg;base64,AAAA" });
  f.picker.stop(f.win);
  assert.equal(f.watches[0].stopped, true);
  assert.deepEqual(normalizeModel({ sections: [{ id: "x", label: "X", targets: [{ id: "bad id!", label: "Bad" }, { id: "ok", label: "Ok", iconPath: "relative.app" }] }],
    notice: { message: "M", link: { label: "Open", url: "file:///etc/passwd" } } }),
  { sections: [{ id: "x", label: "X", targets: [{ id: "ok", label: "Ok", target: null }] }], notice: { message: "M" }, refreshOnFocus: false });
});

test("an icon the module sends itself is shown as sent, without a path lookup", async () => {
  const f = fixture(), looked = [];
  const picker = createAppActionPicker({ appActions: { title: () => "Apply Graphics", watchPicker: (moduleId, actionId, context, update) => { f.watches.push({ update });return { stop() {} }; } },
    iconFor: async file => { looked.push(file);return "data:image/png;base64,UEFUSA=="; }, send: (win, payload) => f.sent.push([win, payload]), choose: async () => {} });
  picker.start(f.win, "window", "applyGraphics");
  f.watches[0].update({ sections: [{ id: "windows", label: "Windows", targets: [
    { id: "window:4", label: "Document", group: { id: "application:9", label: "Example", icon: "data:image/png;base64,SUNPTg==", iconPath: "/Applications/Example.app" } },
    { id: "window:5", label: "Other", group: { id: "application:10", label: "Other", icon: "data:image/svg+xml,<svg/>", iconPath: "/Applications/Other.app" } }] }] });
  await settle();
  const [first, second] = f.sent.at(-1)[1].model.sections[0].targets;
  assert.equal(first.group.icon, "data:image/png;base64,SUNPTg==");
  assert.equal(second.group.icon, "data:image/png;base64,UEFUSA==", "an icon that is not a PNG or JPEG data URL falls back to the path");
  assert.deepEqual(looked, ["/Applications/Other.app"]);
});

test("a replacement picker waits for the preceding catalog to stop and cancels stale starts", async () => {
  let release;const drained = new Promise(resolve => { release = resolve; });const watched = [];
  const picker = createAppActionPicker({ appActions: { title: () => "Picker", watchPicker: (moduleId, actionId, context, update) => {
    watched.push(update);return { stop: () => drained };
  } }, choose: async () => {} });
  const one = {}, two = {}, three = {};
  picker.start(one, "example", "pick");
  picker.start(two, "example", "pick");
  picker.start(three, "example", "pick");
  assert.equal(watched.length, 1);
  release();await settle();
  assert.equal(watched.length, 2, "only the latest window starts after the drain");
  assert.equal(await picker.state(two), null);
  assert.ok(await picker.state(three));
  await picker.stop();
});

test("pause ends the open picker's processes and resume starts it again", async () => {
  const watched = [];let release = null;
  const picker = createAppActionPicker({ appActions: { title: () => "Picker", watchPicker: () => {
    watched.push("start");return { stop: () => new Promise(resolve => { release = () => { watched.push("stopped");resolve(); }; }) };
  } }, choose: async () => {} });
  picker.start({}, "alpha", "apply");
  const pausing = picker.pause();
  await settle();
  assert.deepEqual(watched, ["start"], "pause waits for the picker's processes");
  release();
  const resume = await pausing;
  assert.deepEqual(watched, ["start", "stopped"]);
  resume();
  assert.deepEqual(watched, ["start", "stopped", "start"]);
  const stopping = picker.stop();release();await stopping;
  const idle = await createAppActionPicker({ appActions: {}, choose: async () => {} }).pause();
  idle();
});

test("picker context and its event channel belong to the module action", async () => {
  const context = { request: async () => true, subscribe: () => () => {} };let received;
  const f = fixture();
  const picker = createAppActionPicker({ targetContext: () => context,
    appActions: { title: () => "Picker", watchPicker: (moduleId, actionId, value, update) => {
      received = value;update(model);return { stop() {} };
    } }, choose: async () => {} });
  picker.start(f.win, "window", "applyGraphics");
  assert.equal(received, context, "the generic picker preserves the module's supplied channel");
  await settle();assert.equal((await picker.state(f.win)).sections[0].targets[0].id, "display:1");
  await picker.stop();
});

test("pausing drains the old catalog before resuming and focus keeps that catalog", async () => {
  let release;const drained = new Promise(resolve => { release = resolve; });let starts = 0;
  const picker = createAppActionPicker({ appActions: { title: () => "Picker", watchPicker: () => {
    starts++;return { stop: () => drained };
  } }, choose: async () => {} });
  const win = {};picker.start(win, "window", "applyGraphics");
  const paused = picker.pause();await settle();assert.equal(starts, 1);
  picker.focus(win);assert.equal(starts, 1);
  release();const resume = await paused;assert.equal(starts, 1);
  resume();assert.equal(starts, 2);
  picker.focus(win);assert.equal(starts, 2);
  await picker.stop();
});

test("searchOnly passes through, shown targets stay capped at 256 and search-only targets at searchTargets", async () => {
  const targets = Array.from({ length: 2400 }, (_, index) => ({ id: "window:" + index, label: "W" + index, ...(index % 8 === 0 ? {} : { searchOnly: true }) }));
  targets.push({ id: "window:x", label: "X", searchOnly: "yes" });
  const [section] = normalizeModel({ sections: [{ id: "windows", label: "Windows", targets }] }).sections;
  const shown = section.targets.filter(target => !target.searchOnly), searchable = section.targets.filter(target => target.searchOnly);
  assert.deepEqual([shown.length, searchable.length], [256, 2048]);
  assert.deepEqual(section.targets.slice(0, 3).map(target => [target.id, target.searchOnly]), [["window:0", undefined], ["window:1", true], ["window:2", true]], "order is kept");
  assert.equal(section.targets.some(target => target.id === "window:x"), false, "a target that is not searchOnly counts as shown, and the shown cap is full");
  const f = fixture();
  f.picker.start(f.win, "window", "applyGraphics");
  f.watches[0].update({ sections: [{ id: "windows", label: "Windows", targets: [{ id: "window:7", label: "Hidden", searchOnly: true, target: { kind: "window", windowID: 7 } }] }] });
  await settle();
  assert.deepEqual(f.sent.at(-1)[1].model.sections[0].targets, [{ id: "window:7", label: "Hidden", searchOnly: true }], "the window receives the flag without the module data");
});
