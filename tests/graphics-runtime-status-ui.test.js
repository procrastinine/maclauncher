const assert = require("node:assert/strict"), path = require("node:path"), test = require("node:test"), Module = require("node:module");
const React = require("react"), {renderToStaticMarkup} = require("react-dom/server"), {build} = require("vite");
const {react, componentHarness} = require("./helpers/renderer-component");
let GraphicsRuntimeStatus;
test.before(async () => {
  const result = await build({configFile: false, logLevel: "silent", build: {ssr: path.join(__dirname, "../src/renderer/src/ui/components/GraphicsRuntimeStatus.tsx"),
    write: false, rollupOptions: {external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: {format: "cjs"}}}});
  const compiled = new Module(path.join(__dirname, "graphics-status.cjs"), module);compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(result.output.find(row => row.type === "chunk").code, compiled.id);GraphicsRuntimeStatus = compiled.exports.GraphicsRuntimeStatus;
});
test("status querying is visible, expanded and active only; late replies cannot resurrect a closed inspector", async t => {
  const previousWindow = global.window, previousDocument = global.document;
  t.after(() => {global.window = previousWindow;global.document = previousDocument;});
  let reads = 0, resolve, timers = 0;
  t.mock.method(global, "setTimeout", () => {timers++;return 1;});t.mock.method(global, "clearTimeout", () => {});
  global.document = {visibilityState: "visible"};global.window = {MacLauncher: {launcher: {
    getGameGraphicsStatus: () => {reads++;return new Promise(done => {resolve = done;});}
  }}};
  const props = {game: {gamePath: "/Game", reshade: {enabled: false}}, running: true, visible: true};
  const harness = componentHarness(GraphicsRuntimeStatus, props);t.after(() => harness.close());
  assert.equal(harness.render(), null);assert.equal(reads, 0);assert.equal(timers, 0);
  props.game.reshade.enabled = true;let tree = harness.render();assert.equal(reads, 0, "collapsed status does not query");
  tree.props.onToggle({currentTarget: {open: true}});harness.render();assert.equal(reads, 1);
  props.visible = false;harness.render();resolve({state: "observed", contexts: []});await harness.settle();
  assert.equal(timers, 0);assert.doesNotMatch(renderToStaticMarkup(harness.render()), /Completed processing has been reported/);
});
test("prepared, prior applied, per-row fallback and positive frame counts remain distinct in rendered status", async t => {
  const previousWindow = global.window, previousDocument = global.document;
  t.after(() => {global.window = previousWindow;global.document = previousDocument;});
  t.mock.method(global, "setTimeout", () => 1);t.mock.method(global, "clearTimeout", () => {});
  global.document = {visibilityState: "visible"};
  const status = {state: "prepared", preparation: {pending: [{id: "new", method: "lsfg", reason: "A model is not bound.", retained: true}], skipped: [{id: "old", reason: "Earlier model unavailable."}]}, contexts: []};
  global.window = {MacLauncher: {launcher: {getGameGraphicsStatus: async () => status}}};
  const props = {game: {gamePath: "/Game", reshade: {enabled: true}}, running: true, visible: true};
  const harness = componentHarness(GraphicsRuntimeStatus, props);t.after(() => harness.close());
  harness.render().props.onToggle({currentTarget: {open: true}});harness.render();await harness.settle();
  let markup = renderToStaticMarkup(harness.render());assert.match(markup, /Settings prepared/);assert.match(markup, /Pending.*previous setting is retained/);
  assert.match(markup, /Last preparation · old: Earlier model unavailable/);
  assert.doesNotMatch(markup, /Completed processing has been reported/);
  status.contexts = [{pid: 42, id: "abc", phase: "completed", input: {width: 640, height: 360}, output: {width: 1280, height: 720},
    encoded: 5, completed: 4, presentedReal: 0, presentedGenerated: 0, presentedTime: 0, matchesPrepared: false, identityState: "previous",
    stages: [{id: "nn", requestedMethod: "mlx-dlss", activeMethod: "passthrough", phase: "bypassed", input: {width: 640, height: 360},
      output: {width: 640, height: 360}, reason: "Model unavailable"}]}];
  props.game = {...props.game};harness.render();await harness.settle();markup = renderToStaticMarkup(harness.render());
  assert.match(markup, /Previous settings/);assert.match(markup, /Encoded 5 · Completed 4 · Presented 0 real \/ 0 generated/);
  assert.match(markup, /Presentation has not been reported/);assert.match(markup, /mlx-dlss → passthrough: Bypassed/);
  assert.match(markup, /640 × 360 → Output 1280 × 720/);assert.doesNotMatch(markup, /Completed processing has been reported/);
  status.state = "unverified";status.contexts[0].identityState = "unverified";
  props.game = {...props.game};harness.render();await harness.settle();markup = renderToStaticMarkup(harness.render());
  assert.match(markup, /Completed work is reported, but its settings version could not be confirmed/);
  assert.match(markup, /Settings version not confirmed/);assert.doesNotMatch(markup, /Previous settings/);
});
function activationFixture(t) {
  const previousWindow = global.window, previousDocument = global.document, timers = new Map(), replies = [];let serial = 0, reads = 0;
  t.after(() => {global.window = previousWindow;global.document = previousDocument;});
  t.mock.method(global, "setTimeout", (run, delay) => {timers.set(++serial, {run, delay});return serial;});
  t.mock.method(global, "clearTimeout", id => timers.delete(id));global.document = {visibilityState: "visible"};
  global.window = {MacLauncher: {launcher: {getGameGraphicsStatus: path => {
    assert.equal(path, "/Game");reads++;return new Promise(resolve => replies.push(resolve));
  }}}};
  const props = {game: {gamePath: "/Game", graphics: {neuralMethod: "mlx-dlss", neuralModelPath: "/Models/One.dlssmodel"}}, running: true, visible: true, live: true};
  const harness = componentHarness(GraphicsRuntimeStatus, props);t.after(() => harness.close());
  const tick = delay => {const row = [...timers].find(([, value]) => value.delay === delay);assert.ok(row, `Missing ${delay} ms timer`);timers.delete(row[0]);row[1].run();};
  return {harness, props, replies, timers, tick, reads: () => reads, markup: () => renderToStaticMarkup(harness.render())};
}
function neuralObservation(identityState = "matching", phase = "completed", completed = 1) {
  return observation([{id: "neural", requestedMethod: "mlx-dlss", activeMethod: "mlx-dlss", phase, completed}], identityState);
}
function observation(stages, identityState = "matching") {
  const size = {width: 640, height: 360};
  return {state: "observed", contexts: [{id: "frame", pid: 42, identityState, historical: false, phase: "completed", input: size, output: size,
    encoded: 1, completed: 1, presentedReal: 0, presentedGenerated: 0, presentedTime: 0, stages: stages.map(row => ({input: size, output: size, ...row}))}]};
}
test("live Simple neural activation uses the existing status reader until a current neural frame completes", async t => {
  const f = activationFixture(t);f.harness.render();assert.equal(f.reads(), 1);
  assert.match(f.markup(), /Waiting for the first completed neural frame/);assert.match(f.markup(), /aria-busy="true"/);
  f.replies.shift()(neuralObservation("previous"));await f.harness.settle();assert.doesNotMatch(f.markup(), /Neural reconstruction has completed/);
  f.tick(2000);f.replies.shift()(observation([{id: "shader", requestedMethod: "crt", activeMethod: "crt", phase: "completed", completed: 4}]));
  await f.harness.settle();assert.match(f.markup(), /Waiting for the first completed neural frame/);
  f.tick(2000);f.replies.shift()(neuralObservation("matching", "encoded", 0));await f.harness.settle();
  assert.match(f.markup(), /Waiting for the first completed neural frame/);
  f.tick(2000);f.replies.shift()(neuralObservation("matching", "encoded", 1));await f.harness.settle();
  assert.match(f.markup(), /Neural reconstruction has completed a frame/);assert.equal(f.timers.size, 0);assert.equal(f.reads(), 4);
  f.props.game.graphics = {...f.props.game.graphics};f.harness.render();assert.equal(f.reads(), 4, "identical library broadcasts do not restart activation");
});
test("Off, Stop and new neural selections reject late activation replies without background polling", async t => {
  const f = activationFixture(t);f.harness.render();const older = f.replies.shift();
  f.props.game.graphics = {...f.props.game.graphics, neuralModelPath: "/Models/Two.dlssmodel"};f.harness.render();const current = f.replies.shift();
  older(neuralObservation());await f.harness.settle();assert.match(f.markup(), /Waiting for the first completed neural frame/);
  f.props.game.graphics = {...f.props.game.graphics, neuralMethod: "off", frameGeneration: "lsfg"};f.harness.render();
  current(neuralObservation());await f.harness.settle();assert.doesNotMatch(f.markup(), /Waiting for the first completed neural frame|Neural reconstruction has completed/);
  assert.equal(f.timers.size, 0);assert.equal(f.reads(), 2);
  f.props.game.graphics.neuralMethod = "mlx-dlss";f.harness.render();assert.equal(f.reads(), 3);
  f.props.running = false;assert.equal(f.harness.render(), null);assert.equal(f.timers.size, 0);
  f.replies.shift()(neuralObservation());await f.harness.settle();assert.equal(f.reads(), 3);
});
test("automatic neural waiting has a fixed deadline even when the status request never resolves", async t => {
  const f = activationFixture(t);f.harness.render();f.tick(120000);await f.harness.settle();
  assert.match(f.markup(), /has not reported a completed frame yet/);assert.doesNotMatch(f.markup(), /aria-busy="true"/);assert.equal(f.timers.size, 0);
  f.replies.shift()(neuralObservation());await f.harness.settle();assert.doesNotMatch(f.markup(), /Neural reconstruction has completed/);assert.equal(f.reads(), 1);
});
test("current neural fallback ends automatic waiting and hidden or nonlive settings do not request status", async t => {
  const f = activationFixture(t);f.props.live = false;f.harness.render();assert.equal(f.reads(), 0);
  f.props.live = true;f.props.visible = false;f.harness.render();assert.equal(f.reads(), 0);
  f.props.visible = true;f.harness.render();f.replies.shift()({state: "prepared", contexts: [], preparation: {pending: [{kind: "neural", method: "mlx-dlss", reason: "The selected model is unavailable."}]}});
  await f.harness.settle();assert.match(f.markup(), /Neural reconstruction is unavailable for these settings/);assert.match(f.markup(), /selected model is unavailable/);
  assert.equal(f.timers.size, 0);
});
test("a completed exact-frame neural result is accepted but an unverified cached result is not", async t => {
  const f = activationFixture(t);f.harness.render();
  f.replies.shift()(observation([{id: "neural", requestedMethod: "mlx-dlss", activeMethod: "mlx-dlss-cache", phase: "completed", completed: 1}], "unverified"));
  await f.harness.settle();assert.match(f.markup(), /Waiting for the first completed neural frame/);
  f.tick(2000);f.replies.shift()(observation([{id: "neural", requestedMethod: "mlx-dlss", activeMethod: "mlx-dlss-cache", phase: "completed", completed: 1}]));
  await f.harness.settle();assert.match(f.markup(), /Neural reconstruction has completed a frame/);assert.equal(f.timers.size, 0);
});
test("encoded pending neural frames retain only successful current-identity completion evidence", async t => {
  const f = activationFixture(t);f.harness.render();
  const pending = (completed, identity = "matching", phase = "encoded") => observation([
    {id: "neural", requestedMethod: "mlx-dlss", activeMethod: "pending", phase, completed}], identity);
  f.replies.shift()(pending(264, "previous"));await f.harness.settle();assert.match(f.markup(), /Waiting for the first completed neural frame/);
  f.tick(2000);f.replies.shift()(pending(0));await f.harness.settle();assert.match(f.markup(), /Waiting for the first completed neural frame/);
  f.tick(2000);f.replies.shift()(pending(264));await f.harness.settle();
  assert.match(f.markup(), /Neural reconstruction has completed a frame/);assert.equal(f.timers.size, 0);
});
