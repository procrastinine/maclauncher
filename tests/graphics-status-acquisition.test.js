const test = require("node:test"), assert = require("node:assert/strict");
const Status = require("../src/main/graphics-status");
const {effectSelectionKey} = require("../src/modules/shared/effects/selection-key.mjs");

// Live model acquisition (S13): consent, download, resume and publish, with
// cancellation, supersession and game exit. No download starts before consent.
const settle = async () => {for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve));};
function fakeClock() {
  let now = 1000, id = 0;const timers = new Map();
  return {now: () => now, setTimeout(callback, ms) {const key = ++id;timers.set(key, {at: now + ms, callback});return key;},
    clearTimeout(key) {timers.delete(key);}, get timers() {return timers.size;},
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);now = next[1].at;next[1].callback();await settle();
      }
      now = end;await settle();
    }};
}
const nr = {id: "nr", kind: "upscale", method: "realesrgan", enabled: true, settings: {modelPath: null}};
const gray = {id: "gray", kind: "shader", enabled: true, shader: {enabled: true, preset: "grayscale"}};
const plan = (...video) => ({schema: 2, mode: "advanced", enabled: true, video});
const acquisition = (overrides = {}) => ({operation: "realesrgan", source: {version: "general", label: "General", bytes: 1000, setupActionId: "downloadModel:general"},
  rows: [{id: "nr", selectionKey: effectSelectionKey(nr)}], usable: true, ...overrides});
function models() {
  const state = {consents: [], downloads: [], installed: false, active: false};
  return {state,
    installed: () => state.installed, active: () => state.active,
    consent: request => new Promise((resolve, reject) => {
      const row = {request, resolve, closed: false};state.consents.push(row);
      request.signal.addEventListener("abort", () => {row.closed = true;reject(request.signal.reason);}, {once: true});
    }),
    download: request => new Promise((resolve, reject) => {
      const row = {request, resolve, reject, aborted: false};state.downloads.push(row);
      request.signal.addEventListener("abort", () => {row.aborted = true;reject(request.signal.reason);}, {once: true});
    })};
}
function fixture() {
  const clock = fakeClock(), events = [], resumed = [], backend = models();
  const owner = Status.createGraphicsStatusOwner({clock, models: backend, resume: gamePath => resumed.push(gamePath), send: event => events.push(event)});
  const start = (gamePath = "/Games/A", options = {}) => {
    owner.bound(gamePath, {launchId: "launch-" + gamePath, pid: 1, live: true});
    const seq = owner.desired(gamePath, {revision: "r1", plan: plan(gray, nr)});
    owner.prepared(gamePath, seq, {pending: [{id: "nr", reason: "A compatible model is needed."}], acquisitions: [acquisition(options)]});
    return seq;
  };
  return {clock, events, resumed, backend, owner, start, status: (gamePath = "/Games/A") => owner.status(gamePath)};
}

test("consent, download progress and resume publish the selected model during play", async () => {
  const f = fixture(), seq = f.start();
  f.owner.published("/Games/A", seq, {documentRevision: "doc-rest"});f.owner.ack("/Games/A", {documentRevision: "doc-rest"});
  let status = f.status();
  assert.equal(status.phase, "acquiring");assert.equal(status.acquisition.state, "consent");assert.equal(status.reason, Status.REASONS.consent);
  assert.deepEqual(status.rows.nr, {state: "acquiring", reason: Status.REASONS.consent});assert.deepEqual(status.rows.gray, {state: "active"});
  assert.equal(f.backend.state.consents.length, 1);assert.equal(f.backend.state.downloads.length, 0, "no network before consent");
  assert.deepEqual(f.backend.state.consents[0].request.gamePaths, ["/Games/A"]);
  f.backend.state.consents[0].resolve(true);await settle();
  assert.equal(f.backend.state.downloads.length, 1);assert.equal(f.status().acquisition.state, "downloading");
  const download = f.backend.state.downloads[0];
  download.request.onProgress({downloaded: 420, total: 1000});
  status = f.status();assert.equal(status.acquisition.received, 420);assert.equal(status.reason, "Downloading model… 42%");
  download.resolve({version: "general"});await settle();
  assert.deepEqual(f.resumed, ["/Games/A"]);assert.equal(f.status().phase, "preparing");assert.equal(f.status().acquisition, undefined);
  f.owner.prepared("/Games/A", seq, {pending: []});f.owner.published("/Games/A", seq, {documentRevision: "doc-all"});
  f.owner.ack("/Games/A", {documentRevision: "doc-all"});
  assert.equal(f.status().phase, "applied");assert.deepEqual(f.status().rows.nr, {state: "active"});
  await f.clock.advance(1000);assert.equal(f.clock.timers, 0);assert.deepEqual(f.owner.acquisitions(), []);
});

test("download progress reaches status at most four times a second", async () => {
  const f = fixture();f.start();await f.clock.advance(100);
  f.backend.state.consents[0].resolve(true);await settle();await f.clock.advance(100);
  const before = f.events.length, download = f.backend.state.downloads[0];
  for (let index = 1; index <= 20; index++) {download.request.onProgress({downloaded: index * 10, total: 1000});await f.clock.advance(25);}
  assert.ok(f.events.length - before <= 3, `${f.events.length - before} progress events in 500 ms`);
});

test("a declined download leaves the row pending and does not prompt again until the row changes", async () => {
  const f = fixture(), seq = f.start();
  f.backend.state.consents[0].resolve(false);await settle();
  assert.equal(f.backend.state.downloads.length, 0);
  f.owner.published("/Games/A", seq, {documentRevision: "doc-rest"});f.owner.ack("/Games/A", {documentRevision: "doc-rest"});
  assert.equal(f.status().phase, "partial");assert.equal(f.status().reason, Status.REASONS.declined);
  assert.deepEqual(f.status().rows.nr, {state: "pending", reason: Status.REASONS.declined});
  const edit = f.owner.desired("/Games/A", {revision: "r2", plan: plan({...gray, shader: {...gray.shader, parameters: {x: [1]}}}, nr)});
  f.owner.prepared("/Games/A", edit, {pending: [{id: "nr"}], acquisitions: [acquisition()]});await settle();
  assert.equal(f.backend.state.consents.length, 1, "an unrelated edit does not prompt again");
  assert.equal(f.status().rows.nr.reason, Status.REASONS.declined);
  f.owner.desired("/Games/A", {revision: "r3", plan: plan(gray, {...nr, enabled: false})});
  const again = f.owner.desired("/Games/A", {revision: "r4", plan: plan(gray, nr)});
  f.owner.prepared("/Games/A", again, {pending: [{id: "nr"}], acquisitions: [acquisition()]});await settle();
  assert.equal(f.backend.state.consents.length, 2, "turning the row Off and On selects the model again");
});

test("Cancel aborts an owned download and only detaches from a shared one", async () => {
  const f = fixture();f.start();
  f.backend.state.consents[0].resolve(true);await settle();
  assert.equal(f.owner.cancel("/Games/A"), true);await settle();
  assert.equal(f.backend.state.downloads[0].aborted, true);
  assert.equal(f.status().phase, "preparing");assert.deepEqual(f.status().rows.nr, {state: "pending", reason: Status.REASONS.cancelled});
  assert.deepEqual(f.owner.acquisitions(), []);
  const edit = f.owner.desired("/Games/A", {revision: "r2", plan: plan({...gray, enabled: false}, nr)});
  f.owner.prepared("/Games/A", edit, {pending: [{id: "nr"}], acquisitions: [acquisition()]});await settle();
  assert.equal(f.backend.state.consents.length, 1, "a cancelled selection is not requested again by an unrelated edit");
  assert.equal(f.status().rows.nr.reason, Status.REASONS.cancelled);

  const shared = fixture();shared.start("/Games/A");shared.start("/Games/B");
  assert.equal(shared.backend.state.consents.length, 1, "one consent for both games");
  assert.deepEqual(shared.owner.acquisitions()[0].waiters, ["/Games/A", "/Games/B"]);
  shared.backend.state.consents[0].resolve(true);await settle();
  shared.owner.cancel("/Games/A");await settle();
  assert.equal(shared.backend.state.downloads[0].aborted, false, "another game still waits for the download");
  shared.backend.state.downloads[0].resolve({version: "general"});await settle();
  assert.deepEqual(shared.resumed, ["/Games/B"]);
});

test("a superseding edit closes the consent dialog or cancels an unshared download", async () => {
  const f = fixture();f.start();
  f.owner.desired("/Games/A", {revision: "r2", plan: plan(gray)});await settle();
  assert.equal(f.backend.state.consents[0].closed, true, "the signal closes the dialog");
  assert.equal(f.backend.state.downloads.length, 0);assert.equal(f.status().phase, "preparing");assert.equal(f.status().acquisition, undefined);

  const download = fixture();download.start();
  download.backend.state.consents[0].resolve(true);await settle();
  download.owner.desired("/Games/A", {revision: "r2", plan: {...plan(gray, nr), enabled: false}});await settle();
  assert.equal(download.backend.state.downloads[0].aborted, true, "master Off no longer needs the model");
  assert.deepEqual(download.resumed, []);

  const kept = fixture();kept.start();
  kept.backend.state.consents[0].resolve(true);await settle();
  kept.owner.desired("/Games/A", {revision: "r2", plan: plan({...gray, enabled: false}, nr)});await settle();
  assert.equal(kept.backend.state.downloads[0].aborted, false, "an edit that still needs the model keeps waiting");
  assert.equal(kept.status().phase, "acquiring");
});

test("a game exit closes consent, while a consented download completes for the next launch", async () => {
  const f = fixture();f.start();
  f.owner.ended("/Games/A");await settle();
  assert.equal(f.backend.state.consents[0].closed, true);assert.equal(f.backend.state.downloads.length, 0);
  assert.equal(f.status().phase, "saved");assert.equal(f.status().reason, Status.REASONS.stopped);

  const download = fixture();download.start();
  download.backend.state.consents[0].resolve(true);await settle();
  download.owner.ended("/Games/A");await settle();
  assert.equal(download.backend.state.downloads[0].aborted, false);
  assert.equal(download.status().phase, "saved");assert.equal(download.status().reason, Status.REASONS.downloadingNext);
  download.backend.state.downloads[0].resolve({version: "general"});await settle();
  assert.deepEqual(download.resumed, [], "nothing publishes after the game exits");
  assert.equal(download.status().reason, Status.REASONS.readyNext);
});

test("a launch that cannot load a new model still downloads after consent and applies it next launch (Q3)", async () => {
  const f = fixture(), seq = f.start("/Games/A", {usable: false});
  f.owner.published("/Games/A", seq, {documentRevision: "doc-rest"});f.owner.ack("/Games/A", {documentRevision: "doc-rest"});
  assert.equal(f.backend.state.consents.length, 1, "consent is requested during play");
  f.backend.state.consents[0].resolve(true);await settle();f.backend.state.downloads[0].resolve({version: "general"});await settle();
  assert.deepEqual(f.resumed, []);
  assert.equal(f.status().phase, "partial");assert.equal(f.status().reason, Status.REASONS.readyNext);
  assert.deepEqual(f.status().rows.nr, {state: "pending", reason: Status.REASONS.readyNext});
});

test("an active download is joined without consent and an installed model resumes immediately", async () => {
  const f = fixture();f.backend.state.active = true;f.start();await settle();
  assert.equal(f.backend.state.consents.length, 0);assert.equal(f.backend.state.downloads.length, 1);
  assert.equal(f.status().acquisition.state, "downloading");
  f.owner.cancel("/Games/A");await settle();
  assert.equal(f.backend.state.downloads[0].aborted, false, "a download started elsewhere is not cancelled");

  const ready = fixture();ready.backend.state.installed = true;ready.start();await settle();
  assert.equal(ready.backend.state.consents.length, 0);assert.equal(ready.backend.state.downloads.length, 0);
  assert.deepEqual(ready.resumed, ["/Games/A"]);
});

test("a failed download leaves the row pending with its error", async () => {
  const f = fixture(), seq = f.start();
  f.backend.state.consents[0].resolve(true);await settle();
  f.backend.state.downloads[0].reject(new Error("The model asset does not match its source checksum."));await settle();
  f.owner.published("/Games/A", seq, {documentRevision: "doc-rest"});f.owner.ack("/Games/A", {documentRevision: "doc-rest"});
  assert.equal(f.status().phase, "partial");assert.match(f.status().rows.nr.reason, /checksum/);
  assert.deepEqual(f.resumed, []);
});
