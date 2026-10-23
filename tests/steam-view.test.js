const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const React = require("react");
const { build } = require("vite");

let SteamView, normalizeSteamVersions, depotMatchesArchitecture, currentHooks;
const react = { ...React };
for (const hook of ["useState", "useRef", "useEffect", "useMemo", "useCallback"]) {
  react[hook] = (...args) => currentHooks ? currentHooks[hook](...args) : React[hook](...args);
}
test.before(async () => {
  const result = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "../src/renderer/src/ui/components/SteamView.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs", codeSplitting: false } }
  } });
  const compiled = new Module(path.join(__dirname, "steam-view.cjs"), module);
  compiled.paths = module.paths;
  compiled.require = id => id === "react" ? react : Module.prototype.require.call(compiled, id);
  compiled._compile(result.output.find(chunk => chunk.type === "chunk").code, compiled.id);
  ({ SteamView, normalizeSteamVersions, depotMatchesArchitecture } = compiled.exports);
});

function harness(Component, props) {
  const slots = [];
  let cursor = 0, effects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory, dependencies) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].dependencies, dependencies)) slots[index] = { value: factory(), dependencies };
    return slots[index].value;
  };
  const hooks = {
    useState(initial) {
      const index = cursor++;
      slots[index] ||= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useMemo: memo,
    useCallback: (callback, dependencies) => memo(() => callback, dependencies),
    useEffect(effect, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || !same(previous.dependencies, dependencies)) {
        slots[index] = { dependencies };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); });
      }
    }
  };
  return {
    render() {
      cursor = 0; currentHooks = hooks;
      let tree;
      try { tree = Component(props); } finally { currentHooks = undefined; }
      const pending = effects; effects = []; pending.forEach(effect => effect());
      return tree;
    },
    async settle() { await new Promise(resolve => setImmediate(resolve)); return this.render(); },
    close() { slots.forEach(slot => slot?.cleanup?.()); }
  };
}
function elements(element) {
  return React.isValidElement(element) ? [element, ...React.Children.toArray(element.props.children).flatMap(elements)] : [];
}
const find = (tree, predicate) => elements(tree).find(predicate);
const checkbox = (tree, name) => find(tree, node => node.type === "input" && node.props["aria-label"] === name);
const select = (tree, name) => find(tree, node => node.type === "select" && node.props["aria-label"] === name) ||
  elements(tree).filter(node => typeof node.type === "function" && ["PlatformTagFilter", "TagCheckboxFilter", "LibrarySortSelect"].includes(node.type.name)).flatMap(node => {
    const rendered = node.type(node.props);
    if (rendered.type === "select") return [rendered];
    return rendered.props["aria-label"] === name ? [{ props: { "aria-label": name, onChange: event => node.props.onChange(event.target.value === "all" ? new Set(["macos", "windows", "linux", "web", "android"]) : new Set([event.target.value])) } }] : [];
  }).find(node => node.props["aria-label"] === name);
const button = (tree, label) => find(tree, node => node.type === "button" && React.Children.toArray(node.props.children).some(child => child === label));
const buttonByLabel = (tree, label) => find(tree, node => node.type === "button" && node.props["aria-label"] === label);
const tagCheckbox = (tree, label) => elements(tree).filter(node => typeof node.type === "function" && ["PlatformTagFilter", "TagCheckboxFilter"].includes(node.type.name))
  .flatMap(node => elements(node.type(node.props))).find(node => node.type === "input" && node.props["aria-label"] === label) || checkbox(tree, label);
const game = (id, name, platform = "macos", imported = false) => ({ id, appId: id, name, platform, imported,
  path: `/Steam/common/${name}`, gamePath: `/Steam/common/${name}`, source: "steam", libraryPath: "/Steam" });
function setup(games = [], copies = []) {
  const calls = [], listeners = {};
  const previousWindow = global.window;
  global.window = { addEventListener: (name, callback) => { listeners[name] = callback; }, removeEventListener: name => { delete listeners[name]; } };
  let publish;
  const externalListeners = new Set();
  const state = { connection: { status: "disconnected" }, library: [], libraryLoading: false, downloads: [], imports: [], defaultDirectory: "/Profile/steam/downloads" };
  const api = {
    steamState: async () => { calls.push(["state"]); return state; },
    steamScan: async () => { calls.push(["scan"]); return games; },
    externalDownloaded: async () => { calls.push(["copies"]); return copies; },
    externalImportCopies: async ids => { calls.push(["import-copies", ids]); },
    externalOpenDownloads: async store => { calls.push(["open-downloads", store]); },
    onSteamState: callback => { publish = callback; return () => { publish = null; }; },
    steamImport: async ids => { calls.push(["import", ids]); },
    steamConnect: async credentials => { calls.push(["connect", credentials]); },
    steamAuth: async response => { calls.push(["auth", response]); },
    steamDisconnect: async () => { calls.push(["disconnect"]); },
    steamSelectAccount: async id => { calls.push(["select-account", id]); },
    steamRemoveAccount: async id => { calls.push(["remove-account", id]); },
    steamLibrary: async refresh => { calls.push(["library", refresh]); },
    steamVersions: async id => { calls.push(["versions", id]); return { appId: id, platforms: ["macos", "windows"], branches: [{ id: "public", name: "public" }], history: [],
      depots: [{ id: "100", name: "Game files", platforms: ["windows"], architectures: [], languages: [], manifests: { public: { id: "900", size: 100 } }, encryptedBranches: [] }] }; },
    steamPreviousVersions: async (appId, ids, refresh) => { calls.push(["history", appId, ids, refresh]); return { history: [], sourceUrl: "https://steamdb.info/app/1/depots/", sources: [], fetchedAt: "2026-10-20" }; },
    steamOpenHistory: async (appId, depotId) => { calls.push(["open-history", appId, depotId]); },
    steamChooseDirectory: async () => "/Custom downloads",
    steamDownload: async selection => { calls.push(["download", selection]); },
    externalState: async store => { calls.push(["external-state", store]); return state; },
    onExternalState: callback => { externalListeners.add(callback); return () => externalListeners.delete(callback); },
    externalConnect: async (store, credentials) => { calls.push(["external-connect", store, credentials]); },
    externalAddGame: async (store, url) => { calls.push(["external-add-game", store, url]); return { ...state, connection: { status: "connected", mode: "public", displayName: "Public games" }, library: [{ appId: "public-game", name: "Public example", platforms: ["windows", "macos"], shared: false }] }; },
    externalDisconnect: async store => { calls.push(["external-disconnect", store]); },
    externalForget: async store => { calls.push(["external-forget", store]); },
    externalAuth: async (store, credentials) => { calls.push(["external-auth", store, credentials]); },
    externalOpenLogin: async store => { calls.push(["external-login", store]); },
    externalAddToLibrary: async (store, appId, options) => { calls.push(["external-add-to-library", store, appId, options]); return { ...state, connection: { status: "connected", mode: "microg", accountName: "account" }, library: [{ appId, name: "Android example", platforms: ["android"], shared: false, owned: true }] }; },
    externalAccounts: async (store, refresh) => { calls.push(["external-accounts", store, refresh]); if (!refresh) return { accounts: [], providers: [] }; return { accounts: [{ id: "shared:available", label: "Shared account", source: "microG", available: true }, { id: "shared:cached", label: "Cached account", source: "Mac.apk", available: false }], providers: [] }; },
    externalOpenAccounts: async store => { calls.push(["external-account-settings", store]); },
    externalSearch: async (store, query) => { calls.push(["external-search", store, query]); return [{ appId: "com.example.game", name: "Android example", platforms: ["android"], shared: false, owned: false, versionCode: "1024" }]; },
    externalLibrary: async (store, refresh) => { calls.push(["external-library", store, refresh]); },
    externalVersions: async (store, id) => { calls.push(["external-versions", store, id]); return { appId: id, name: "Example", platforms: ["windows", "macos"],
      branches: [{ id: "current", name: "Current version" }], depots: [], history: [], languages: ["english", "french"], supportsManifestOverride: store === "epic" }; },
    externalDownload: async (store, selection) => { calls.push(["external-download", store, selection]); },
    externalCancel: async (store, id) => { calls.push(["external-cancel", store, id]); },
    externalImportDownload: async (store, id) => { calls.push(["external-import", store, id]); }
  };
  const view = harness(SteamView, { api });
  return { view, api, calls, state, listeners, publish: value => publish(value), publishExternal: (store, value) => externalListeners.forEach(callback => callback({ store, state: value })),
    close() { view.close(); global.window = previousWindow; } };
}

test("opening and rescanning Installed stay offline; Download tab uses cached state until Reload", async () => {
  const context = setup([game("1", "Example")]);
  try {
    context.view.render(); await context.view.settle();
    assert.deepEqual(context.calls.map(call => call[0]), ["state", "scan", "copies"]);
    buttonByLabel(context.view.render(), "Rescan installed games").props.onClick(); await context.view.settle();
    assert.equal(context.calls.filter(call => call[0] === "scan").length, 2);
    find(context.view.render(), node => node.props.id === "steam-download-tab").props.onClick();
    context.publish({ ...context.state, connection: { status: "connected", accountName: "account" } });
    assert.deepEqual(context.calls.map(call => call[0]), ["state", "scan", "copies", "scan"]);
    buttonByLabel(context.view.render(), "Reload Steam library").props.onClick(); await context.view.settle();
    assert.deepEqual(context.calls.at(-1), ["library", true]);
  } finally { context.close(); }
});

test("External tabs and store filtering preserve hidden selections without querying stores", async () => {
  const context = setup([{ ...game("1", "Steam game"), store: "steam" }, { ...game("2", "Epic game"), store: "epic", source: "heroic" }, { ...game("3", "GOG game"), store: "gog", source: "gog" }]);
  try {
    context.view.render(); await context.view.settle();
    for (const label of ["steam-installed-tab", "steam-downloaded-tab", "steam-download-tab", "steam-epic-tab", "steam-gog-tab", "steam-itch-tab", "steam-google-play-tab"]) assert.ok(find(context.view.render(), node => node.props.id === label));
    checkbox(context.view.render(), "Select Steam game").props.onClick({ shiftKey: false, stopPropagation() {} });
    select(context.view.render(), "Filter stores").props.onChange({ target: { value: "epic" } });
    assert.equal(checkbox(context.view.render(), "Select Steam game"), undefined);
    checkbox(context.view.render(), "Select all visible games").props.onChange({ target: { checked: true } });
    button(context.view.render(), "Import 2 games").props.onClick(); await context.view.settle();
    assert.deepEqual(context.calls.at(-1), ["import", ["1", "2"]]);
    assert.equal(context.calls.some(call => call[0].startsWith("external-")), false);
  } finally { context.close(); }
});

test("Downloaded copies stay separate from installations, keep independent selections and import by copy ID", async () => {
  const copy = { ...game("copy-1", "Pinned release"), source: "managed", versionName: "1.2", path: "/Custom copies/Example-1.2" };
  const context = setup([game("installed-1", "Store installation"), copy], [copy, { ...copy, id: "copy-2", name: "Second copy", versionName: "1.1" }]);
  try {
    context.view.render(); await context.view.settle();
    assert.equal(checkbox(context.view.render(), "Select Pinned release"), undefined);
    checkbox(context.view.render(), "Select Store installation").props.onClick({ shiftKey: false, stopPropagation() {} });
    find(context.view.render(), node => node.props.id === "steam-downloaded-tab").props.onClick();
    assert.equal(checkbox(context.view.render(), "Select Store installation"), undefined);
    assert.equal(checkbox(context.view.render(), "Select Pinned release").props.checked, false);
    checkbox(context.view.render(), "Select Pinned release").props.onClick({ shiftKey: true, stopPropagation() {} });
    assert.equal(checkbox(context.view.render(), "Select Second copy").props.checked, false);
    button(context.view.render(), "Open downloads in Finder").props.onClick();
    assert.deepEqual(context.calls.at(-1), ["open-downloads", undefined]);
    buttonByLabel(context.view.render(), "Reload downloaded copies").props.onClick(); await context.view.settle();
    assert.deepEqual(context.calls.at(-1), ["copies"]);
    button(context.view.render(), "Import game").props.onClick(); await context.view.settle();
    assert.deepEqual(context.calls.at(-1), ["import-copies", ["copy-1"]]);
    find(context.view.render(), node => node.props.id === "steam-installed-tab").props.onClick();
    assert.equal(checkbox(context.view.render(), "Select Store installation").props.checked, true);
    assert.equal(checkbox(context.view.render(), "Select Pinned release"), undefined);
  } finally { context.close(); }
});

test("Installed versions use meaningful publisher versions, build IDs and an empty marker", async () => {
  const context = setup([{ ...game("1", "Versioned"), versionName: "Release 1.2", version: "1.2", buildId: "300", branch: "public" },
    { ...game("2", "Build only"), versionName: "unknown", buildId: "400" }, game("3", "No version")]);
  try {
    context.view.render(); await context.view.settle();
    const cells = elements(context.view.render()).filter(node => node.props.className === "steamInstalledVersion");
    assert.deepEqual(cells.map(node => node.props.children), ["Build 400", "—", "Release 1.2"]);
    assert.match(cells[2].props.title, /Branch public/); assert.match(cells[2].props.title, /Build 300/);
  } finally { context.close(); }
});

test("Epic browser sign-in uses authorization codes and isolates unrelated provider state", async () => {
  const context = setup();
  let provider;
  try {
    context.view.render(); await context.view.settle();
    find(context.view.render(), node => node.props.id === "steam-epic-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "epic" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    assert.deepEqual(context.calls.at(-1), ["external-state", "epic"]);
    assert.equal(context.calls.some(call => call[0] === "external-connect" || call[0] === "external-library"), false);
    const form = () => find(provider.render(), node => node.type === "form");
    await form().props.onSubmit({ preventDefault() {} });
    assert.deepEqual(context.calls.at(-1), ["external-connect", "epic", { mode: "reuse" }]);
    find(provider.render(), node => node.type === "input" && node.props.value === "manual").props.onChange();
    await form().props.onSubmit({ preventDefault() {} });
    assert.deepEqual(context.calls.at(-1), ["external-connect", "epic", { mode: "manual" }]);
    context.publishExternal("gog", { ...context.state, connection: { status: "connected", accountName: "other" } });
    assert.ok(form());
    context.publishExternal("epic", { ...context.state, connection: { status: "guard", mode: "manual", guard: { kind: "authorization", url: "https://example.invalid/login" } } });
    button(provider.render(), "Open Epic sign-in").props.onClick();
    assert.deepEqual(context.calls.at(-1), ["external-login", "epic"]);
    find(provider.render(), node => node.type === "input" && node.props.autoComplete === "off").props.onChange({ target: { value: "authorization-code" } });
    await form().props.onSubmit({ preventDefault() {} });
    assert.deepEqual(context.calls.at(-1), ["external-auth", "epic", { code: "authorization-code" }]);
  } finally { provider?.close(); context.close(); }
});

test("itch.io API keys stay session-only by default, saving is explicit, and saved keys can be forgotten", async () => {
  const context = setup(); let provider;
  try {
    context.view.render(); await context.view.settle();
    find(context.view.render(), node => node.props.id === "steam-itch-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "itch" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    find(provider.render(), node => node.type === "input" && node.props.name === "itch-library-mode" && node.props.value === "account").props.onChange();
    const key = () => find(provider.render(), node => node.props["aria-label"] === "itch.io API key");
    const form = () => find(provider.render(), node => node.type === "form");
    const save = () => find(provider.render(), node => node.type === "input" && node.props.type === "checkbox");
    assert.equal(key().props.type, "password"); assert.equal(save().props.checked, false);
    assert.equal(find(provider.render(), node => node.type === "input" && node.props.name === "itch-library-mode" && node.props.value === "account").props.checked, true);
    button(provider.render(), "Open API key settings").props.onClick();
    assert.deepEqual(context.calls.at(-1), ["external-login", "itch"]);
    key().props.onChange({ target: { value: "session-key" } });
    await form().props.onSubmit({ preventDefault() {} });
    assert.deepEqual(context.calls.at(-1), ["external-connect", "itch", { mode: "manual", apiKey: "session-key", remember: false }]);
    assert.equal(key().props.value, "");
    key().props.onChange({ target: { value: "saved-key" } }); save().props.onChange({ target: { checked: true } });
    await form().props.onSubmit({ preventDefault() {} });
    assert.deepEqual(context.calls.at(-1), ["external-connect", "itch", { mode: "manual", apiKey: "saved-key", remember: true }]);
    context.publishExternal("itch", { ...context.state, hasSavedKey: true, connection: { status: "connected", mode: "manual", accountName: "itch-account" } });
    button(provider.render(), "Forget saved key").props.onClick(); assert.deepEqual(context.calls.at(-1), ["external-forget", "itch"]);
    button(provider.render(), "Disconnect").props.onClick(); assert.deepEqual(context.calls.at(-1), ["external-disconnect", "itch"]);
    context.publishExternal("itch", { ...context.state, hasSavedKey: true });
    await form().props.onSubmit({ preventDefault() {} });
    assert.deepEqual(context.calls.at(-1), ["external-connect", "itch", { mode: "reuse" }]);
  } finally { provider?.close(); context.close(); }
});

test("Epic and GOG downloads retain platform, edition, destination and explicit auto import choices", async () => {
  for (const store of ["epic", "gog"]) {
    const context = setup(); let provider, options;
    try {
      context.view.render(); await context.view.settle();
      find(context.view.render(), node => node.props.id === `steam-${store}-tab`).props.onClick();
      const component = find(context.view.render(), node => node.props.store === store && node.props.onImported);
      provider = harness(component.type, component.props); provider.render(); await provider.settle();
      context.publishExternal(store, { ...context.state, connection: { status: "connected", mode: "reuse", accountName: "store-account" },
        library: [{ appId: "game-id", name: "Example", platforms: ["windows", "macos"], shared: false }] }); provider.render();
      buttonByLabel(provider.render(), `Reload ${store === "epic" ? "Epic" : "GOG"} library`).props.onClick();
      assert.deepEqual(context.calls.at(-1), ["external-library", store, true]);
      find(provider.render(), node => node.props.className === "steamLibraryButton").props.onClick(); await provider.settle();
      const versionComponent = find(provider.render(), node => node.props.versions && node.props.game);
      options = harness(versionComponent.type, versionComponent.props);
      const download = () => find(options.render(), node => node.type === "button" && node.props.className === "btn primary");
      button(options.render(), "Open default in Finder").props.onClick();
      assert.deepEqual(context.calls.at(-1), ["open-downloads", store]);
      download().props.onClick(); await options.settle();
      assert.equal(context.calls.at(-1)[2].autoImport, true);
      select(options.render(), `${store === "epic" ? "Epic" : "GOG"} download platform`).props.onChange({ target: { value: "macos" } });
      button(options.render(), "Choose folder…").props.onClick(); await options.settle();
      find(options.render(), node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: false } });
      download().props.onClick(); await options.settle();
      assert.deepEqual(context.calls.at(-1), ["external-download", store, { appId: "game-id", name: "Example", platform: "macos", branch: "current", language: "english", architecture: "all", autoImport: false, destination: "/Custom downloads" }]);
      button(options.render(), "Use managed location").props.onClick();
      download().props.onClick(); await options.settle();
      assert.equal(context.calls.at(-1)[2].destination, undefined);
    } finally { options?.close(); provider?.close(); context.close(); }
  }
});

test("exact game build selection survives compatible platform changes and visibly falls back for another platform", async () => {
  const context = setup(); let provider, options;
  try {
    context.view.render(); await context.view.settle();
    context.api.externalVersions = async () => ({ appId: "game-id", name: "Example", platforms: ["windows", "macos", "web"], depots: [], history: [],
      branches: [{ id: "20:300", name: "Release 1.2", buildId: "300", updatedAt: "2026-10-01T00:00:00Z", platforms: ["windows", "macos"] },
        { id: "21:400", name: "Release 2.0", buildId: "400", platforms: ["windows"] }, { id: "30:500", name: "Web release 3.0", buildId: "500", platforms: ["web"] }] });
    find(context.view.render(), node => node.props.id === "steam-itch-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "itch" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    context.publishExternal("itch", { ...context.state, connection: { status: "connected", mode: "public", displayName: "Public games" }, library: [{ appId: "game-id", name: "Example", platforms: ["windows", "macos", "web"], shared: false }] }); provider.render();
    find(provider.render(), node => node.props.className === "steamLibraryButton").props.onClick(); await provider.settle();
    const componentOptions = find(provider.render(), node => node.props.versions && node.props.game);
    options = harness(componentOptions.type, componentOptions.props);
    let selector = select(options.render(), "itch.io download version");
    assert.match(React.Children.toArray(selector.props.children)[0].props.children, /Release 1.2.*Build 300.*2026/);
    select(options.render(), "itch.io download platform").props.onChange({ target: { value: "macos" } });
    assert.equal(select(options.render(), "itch.io download version").props.value, "20:300");
    select(options.render(), "itch.io download platform").props.onChange({ target: { value: "windows" } });
    select(options.render(), "itch.io download version").props.onChange({ target: { value: "21:400" } });
    select(options.render(), "itch.io download platform").props.onChange({ target: { value: "web" } });
    assert.equal(select(options.render(), "itch.io download version").props.value, "30:500");
    assert.match(find(options.render(), node => node.props.role === "status").props.children, /Version changed to Web release 3.0.*Build 500.*Web/);
    find(options.render(), node => node.type === "button" && node.props.className === "btn primary").props.onClick(); await options.settle();
    assert.equal(context.calls.at(-1)[2].branch, "30:500"); assert.equal(context.calls.at(-1)[2].platform, "web");
  } finally { options?.close(); provider?.close(); context.close(); }
});

test("Reuse Steam is the default connection and manual sign-in alone requests credentials", async () => {
  const context = setup();
  try {
    context.view.render(); await context.view.settle();
    const form = () => find(context.view.render(), node => node.type === "form" && node.props.className === "steamLoginForm");
    assert.equal(find(context.view.render(), node => node.type === "input" && node.props.value === "client").props.checked, true);
    assert.equal(find(context.view.render(), node => node.type === "input" && node.props.type === "password"), undefined);
    await form().props.onSubmit({ preventDefault() {} });
    assert.deepEqual(context.calls.at(-1), ["connect", { mode: "client" }]);
    find(context.view.render(), node => node.type === "input" && node.props.value === "manual").props.onChange();
    find(context.view.render(), node => node.type === "input" && node.props.autoComplete === "username").props.onChange({ target: { value: "second-account" } });
    find(context.view.render(), node => node.type === "input" && node.props.type === "password").props.onChange({ target: { value: "sign-in-only" } });
    await form().props.onSubmit({ preventDefault() {} });
    assert.deepEqual(context.calls.at(-1), ["connect", { mode: "manual", accountName: "second-account", password: "sign-in-only", remember: true }]);
    assert.equal(find(context.view.render(), node => node.type === "input" && node.props.type === "password").props.value, "");
  } finally { context.close(); }
});

test("Steam approval challenges wait without demanding codes and support offered code and QR flows", async () => {
  const context = setup();
  try {
    context.view.render(); await context.view.settle();
    find(context.view.render(), node => node.type === "input" && node.props.value === "manual").props.onChange();
    find(context.view.render(), node => node.type === "input" && node.props.autoComplete === "username").props.onChange({ target: { value: "example" } });
    button(context.view.render(), "Sign in with QR code").props.onClick(); await context.view.settle();
    assert.deepEqual(context.calls.at(-1), ["connect", { mode: "manual", accountName: "example", authMethod: "qr", remember: true }]);
    const challenge = () => {
      const node = find(context.view.render(), element => element.props.guard && element.props.onCodeChange);
      return node.type(node.props);
    };
    context.publish({ ...context.state, connection: { status: "guard", mode: "manual", guard: { kind: "mobile", codeKinds: [], message: "Approve this sign-in in Steam." } } });
    assert.equal(find(context.view.render(), node => node.props.className === "steamLoginForm"), undefined);
    assert.equal(find(challenge(), node => node.type === "form"), undefined);
    assert.match(find(challenge(), node => node.props.role === "status").props.children[1], /Waiting for approval/);
    context.publish({ ...context.state, connection: { status: "guard", mode: "manual", guard: { kind: "mobile", codeKinds: ["totp"] } } });
    find(challenge(), node => node.type === "input").props.onChange({ target: { value: "ABCDE" } });
    await find(challenge(), node => node.type === "form").props.onSubmit({ preventDefault() {} });
    assert.deepEqual(context.calls.at(-1), ["auth", { code: "ABCDE" }]);
    const qrImageUrl = "data:image/png;base64,cXItcHJldmlldw==";
    context.publish({ ...context.state, connection: { status: "guard", mode: "manual", guard: { kind: "qr", qrImageUrl, remoteInteraction: true } } });
    assert.equal(find(challenge(), node => node.type === "img").props.src, qrImageUrl);
    assert.match(find(challenge(), node => node.props.role === "status").props.children[1], /Finishing sign-in/);
    button(context.view.render(), "Cancel").props.onClick(); assert.deepEqual(context.calls.at(-1), ["disconnect"]);
  } finally { context.close(); }
});

test("account switching preserves the window and Add account opens blank manual sign-in while connected", async () => {
  const context = setup();
  try {
    context.view.render(); await context.view.settle();
    const state = { ...context.state, connection: { status: "connected", mode: "manual", accountName: "first-account" }, activeAccountId: "first",
      accounts: [{ id: "desktop", accountName: "desktop-account", mode: "client", status: "disconnected" },
        { id: "first", accountName: "first-account", mode: "manual", status: "connected" }, { id: "second", accountName: "second-account", mode: "manual", status: "connected" }] };
    context.publish(state);
    select(context.view.render(), "Steam account").props.onChange({ target: { value: "second" } });
    assert.deepEqual(context.calls.at(-1), ["select-account", "second"]);
    button(context.view.render(), "Add account").props.onClick();
    assert.equal(find(context.view.render(), node => node.type === "input" && node.props.value === "manual").props.checked, true);
    assert.equal(find(context.view.render(), node => node.type === "input" && node.props.autoComplete === "username").props.value, "");
    assert.equal(find(context.view.render(), node => node.type === "input" && node.props.type === "password").props.value, "");
    assert.equal(find(context.view.render(), node => node.props.className === "steamDownloadWorkspace"), undefined);
    button(context.view.render(), "Cancel").props.onClick();
    assert.ok(find(context.view.render(), node => node.props.className === "steamDownloadWorkspace"));
    button(context.view.render(), "Remove account").props.onClick();
    assert.deepEqual(context.calls.at(-1), ["remove-account", "first"]);
  } finally { context.close(); }
});

test("an account switch drops selected depots and ignores the previous account's late versions response", async () => {
  const context = setup();
  try {
    context.view.render(); await context.view.settle();
    let finishVersions;
    context.api.steamVersions = () => new Promise(resolve => { finishVersions = resolve; });
    const state = { ...context.state, connection: { status: "connected", mode: "manual" }, activeAccountId: "first",
      library: [{ appId: "10", name: "First game", platforms: ["windows"], shared: false }] };
    context.publish(state); context.view.render();
    find(context.view.render(), node => node.props.className === "steamLibraryButton").props.onClick();
    context.publish({ ...state, activeAccountId: "second", library: [] }); context.view.render();
    finishVersions({ appId: "10", name: "First game", platforms: ["windows"], branches: [{ id: "public" }], depots: [], history: [] });
    await context.view.settle();
    assert.equal(find(context.view.render(), node => node.props.versions && node.props.game), undefined);
    assert.equal(find(context.view.render(), node => node.props.className === "steamVersionIdentity"), undefined);
  } finally { context.close(); }
});

test("Shift-click selects the filtered range, select-all retains hidden selection, and imports remain asynchronous", async () => {
  const context = setup([game("1", "Alpha"), game("2", "Beta", "windows"), game("3", "Gamma"), game("4", "Omega", "macos", true)]);
  try {
    context.view.render(); await context.view.settle();
    checkbox(context.view.render(), "Select Beta").props.onClick({ shiftKey: false, stopPropagation() {} });
    select(context.view.render(), "Filter platforms").props.onChange({ target: { value: "macos" } });
    checkbox(context.view.render(), "Select Alpha").props.onClick({ shiftKey: false, stopPropagation() {} });
    checkbox(context.view.render(), "Select Gamma").props.onClick({ shiftKey: true, stopPropagation() {} });
    assert.equal(checkbox(context.view.render(), "Select Alpha").props.checked, true);
    assert.equal(checkbox(context.view.render(), "Select Gamma").props.checked, true);
    assert.equal(checkbox(context.view.render(), "Select Omega").props.disabled, true);
    checkbox(context.view.render(), "Select all visible games").props.onChange({ target: { checked: false } });
    select(context.view.render(), "Filter platforms").props.onChange({ target: { value: "all" } });
    assert.equal(checkbox(context.view.render(), "Select Beta").props.checked, true);
    assert.equal(checkbox(context.view.render(), "Select Alpha").props.checked, false);
    let finish;
    context.api.steamImport = ids => { context.calls.push(["import", ids]); return new Promise(resolve => { finish = resolve; }); };
    button(context.view.render(), "Import game").props.onClick();
    assert.deepEqual(context.calls.at(-1), ["import", ["2"]]);
    // Another game remains selectable while the previous import request is pending.
    checkbox(context.view.render(), "Select Gamma").props.onClick({ shiftKey: false, stopPropagation() {} });
    finish(); await context.view.settle();
    assert.equal(checkbox(context.view.render(), "Select Gamma").props.checked, true);
    assert.equal(checkbox(context.view.render(), "Select Beta").props.checked, false);
  } finally { context.close(); }
});

test("background import state rescans on completion rather than on every progress update", async () => {
  const context = setup([game("1", "Example")]);
  try {
    context.view.render(); await context.view.settle();
    for (const status of ["queued", "importing", "importing"]) {
      context.publish({ ...context.state, imports: [{ id: "import-1", name: "Example", status }] }); await context.view.settle();
    }
    assert.equal(context.calls.filter(call => call[0] === "scan").length, 1);
    context.publish({ ...context.state, imports: [{ id: "import-1", name: "Example", status: "completed" }] }); await context.view.settle(); await context.view.settle();
    assert.equal(context.calls.filter(call => call[0] === "scan").length, 2);
    context.view.render(); await context.view.settle();
    assert.equal(context.calls.filter(call => call[0] === "scan").length, 2);
  } finally { context.close(); }
});

test("download selection defaults to auto import and preserves custom destination and historical manifests", async () => {
  const context = setup();
  let options;
  try {
    context.view.render(); await context.view.settle();
    const libraryGame = { appId: "10", name: "Example", platforms: ["macos", "windows"], shared: true };
    context.publish({ ...context.state, connection: { status: "connected" }, library: [libraryGame] });
    find(context.view.render(), node => node.props.className === "steamLibraryButton").props.onClick(); await context.view.settle();
    const child = find(context.view.render(), node => node.props.versions && node.props.game);
    options = harness(child.type, child.props);
    const download = () => find(options.render(), node => node.type === "button" && node.props.className === "btn primary");
    button(options.render(), "Open default in Finder").props.onClick();
    assert.deepEqual(context.calls.at(-1), ["open-downloads", "steam"]);
    download().props.onClick(); await options.settle();
    assert.equal(context.calls.at(-1)[1].autoImport, true);
    assert.equal(context.calls.at(-1)[1].destination, undefined);
    assert.equal(context.calls.at(-1)[1].platform, "windows");
    button(options.render(), "Choose folder…").props.onClick(); await options.settle();
    const importCheck = find(options.render(), node => node.type === "label" && node.props.className === "steamInlineCheck").props.children[0];
    importCheck.props.onChange({ target: { checked: false } });
    find(options.render(), node => node.props["aria-label"] === "Manifest ID for depot 100").props.onChange({ target: { value: "1234567890123456789" } });
    download().props.onClick(); await options.settle();
    assert.equal(context.calls.at(-1)[1].autoImport, false);
    assert.equal(context.calls.at(-1)[1].destination, "/Custom downloads");
    assert.deepEqual(context.calls.at(-1)[1].depots, [{ depotId: "100", manifestId: "1234567890123456789" }]);
    button(options.render(), "Use managed location").props.onClick();
    download().props.onClick(); await options.settle();
    assert.equal(context.calls.at(-1)[1].destination, undefined);
  } finally { options?.close(); context.close(); }
});

test("Steam Android selection keeps PC depots separate and retains the automatic import choice", async () => {
  const context = setup([]); let options;
  try {
    context.api.steamVersions = async () => ({ appId: "10", platforms: ["windows", "android"], branches: [{ id: "public", name: "public" }], history: [],
      architectures: { windows: ["64"], android: ["arm64"] }, architectureLabels: { android: { arm64: "ARM64" } }, depots: [
        { id: "100", name: "PC files", platforms: ["windows"], architectures: ["64"], languages: [], manifests: { public: { id: "200" } }, encryptedBranches: [] },
        { id: "101", name: "Android files", platforms: ["android"], architectures: ["arm64"], languages: [], manifests: { public: { id: "201" } }, encryptedBranches: [] },
        { id: "102", name: "Shared files", platforms: [], architectures: [], languages: [], manifests: { public: { id: "202" } }, encryptedBranches: [] }
      ] });
    context.view.render(); await context.view.settle();
    context.publish({ ...context.state, connection: { status: "connected" }, library: [{ appId: "10", name: "Example", platforms: ["windows", "android"], shared: false }] });
    find(context.view.render(), node => node.props.className === "steamLibraryButton").props.onClick(); await context.view.settle();
    const child = find(context.view.render(), node => node.props.versions && node.props.game);
    options = harness(child.type, child.props);
    select(options.render(), "Steam download platform").props.onChange({ target: { value: "android" } });
    const depots = elements(options.render()).filter(node => node.type === "input" && /^Select depot /.test(node.props["aria-label"] || ""));
    assert.deepEqual(depots.map(node => node.props["aria-label"]).sort(), ["Select depot 101", "Select depot 102"]);
    find(options.render(), node => node.type === "button" && node.props.className === "btn primary").props.onClick(); await options.settle();
    assert.equal(context.calls.at(-1)[1].platform, "android");
    assert.equal(context.calls.at(-1)[1].autoImport, true);
    assert.deepEqual(context.calls.at(-1)[1].depots, [{ depotId: "101" }, { depotId: "102" }]);
  } finally { options?.close(); context.close(); }
});

test("checkbox tag filters combine platforms, stores and import status while sorting preserves selections", async () => {
  const context = setup([{ ...game("1", "Zulu", "windows"), store: "steam", architectureCpu: ["x86_64"] },
    { ...game("2", "Alpha", "macos"), store: "epic", architectureCpu: ["arm64"] },
    { ...game("3", "Beta", "windows", true), store: "gog" }]);
  try {
    context.view.render(); await context.view.settle();
    checkbox(context.view.render(), "Select Zulu").props.onClick({ shiftKey: false, stopPropagation() {} });
    tagCheckbox(context.view.render(), "Filter platforms: Mac").props.onChange({ target: { checked: false } });
    assert.equal(checkbox(context.view.render(), "Select Alpha"), undefined);
    tagCheckbox(context.view.render(), "Filter imported games: Imported").props.onChange({ target: { checked: false } });
    assert.equal(checkbox(context.view.render(), "Select Beta"), undefined);
    button(context.view.render(), "Clear filters").props.onClick();
    select(context.view.render(), "Sort installed games").props.onChange({ target: { value: "name-desc" } });
    assert.deepEqual(elements(context.view.render()).filter(node => node.props.className === "steamGameName").map(node => node.props.children), ["Zulu", "Beta", "Alpha"]);
    assert.equal(checkbox(context.view.render(), "Select Zulu").props.checked, true);
    tagCheckbox(context.view.render(), "Filter stores: Steam").props.onChange({ target: { checked: false } });
    assert.equal(checkbox(context.view.render(), "Select Zulu"), undefined);
    tagCheckbox(context.view.render(), "Filter stores: Steam").props.onChange({ target: { checked: true } });
    assert.equal(checkbox(context.view.render(), "Select Zulu").props.checked, true);
    assert.equal(context.calls.some(call => ["library", "versions", "history", "external-library"].includes(call[0])), false);
    const reload = buttonByLabel(context.view.render(), "Rescan installed games");
    assert.ok(reload); assert.equal(React.Children.toArray(reload.props.children).some(child => typeof child === "string"), false);
    assert.ok(find(context.view.render(), node => typeof node.type === "function" && node.type.name === "HelpTip" && node.props.label === "About installed games"));
  } finally { context.close(); }
});

test("Steam library sorts access and filters Apple Silicon using actual cached metadata", async () => {
  const context = setup();
  try {
    context.view.render(); await context.view.settle();
    context.publish({ ...context.state, connection: { status: "connected" }, library: [
      { appId: "1", name: "Zulu", platforms: ["macos"], shared: true, nativeAppleSilicon: true },
      { appId: "2", name: "Alpha", platforms: ["windows"], shared: false },
      { appId: "3", name: "Beta", platforms: ["macos"], shared: false, nativeAppleSilicon: false }] });
    select(context.view.render(), "Sort Steam library").props.onChange({ target: { value: "access" } });
    const names = () => elements(context.view.render()).filter(node => node.props.className === "steamGameName").map(node => node.props.children);
    assert.deepEqual(names(), ["Alpha", "Beta", "Zulu"]);
    checkbox(context.view.render(), "Filter Steam Apple Silicon games").props.onChange({ target: { checked: true } });
    assert.deepEqual(names(), ["Zulu"]);
    assert.equal(context.calls.filter(call => ["library", "versions", "history"].includes(call[0])).length, 0);
  } finally { context.close(); }
});

test("previous Steam manifests fetch only selected depot IDs and never change chosen downloads automatically", async () => {
  const context = setup(); let options;
  const historical = "1234567890123456789";
  try {
    context.view.render(); await context.view.settle();
    context.api.steamVersions = async () => ({ appId: 10, name: "Example", platforms: ["windows"], branches: [{ id: "public", name: "public", buildId: "500" }],
      depots: [100, 200].map(id => ({ id, name: `Files ${id}`, platforms: ["windows"], architectures: [], languages: [], manifests: { public: { id: String(id + 900), size: 100 } }, encryptedBranches: [] })), history: [] });
    context.api.steamPreviousVersions = async (appId, ids, refresh) => { context.calls.push(["history", appId, ids, refresh]); return {
      history: [{ depotId: "100", manifestId: historical, date: "2023-01-01" }], sourceUrl: "https://steamdb.info/app/10/depots/", sources: [], fetchedAt: "2026-10-20", blocked: true, message: "SteamDB requires browser verification." }; };
    context.publish({ ...context.state, connection: { status: "connected" }, library: [{ appId: "10", name: "Example", platforms: ["windows"], shared: false }] });
    find(context.view.render(), node => node.props.className === "steamLibraryButton").props.onClick(); await context.view.settle();
    const child = find(context.view.render(), node => node.props.versions && node.props.game);
    assert.equal(child.props.versions.depots[0].id, "100");
    options = harness(child.type, child.props); options.render();
    assert.equal(context.calls.some(call => call[0] === "history"), false);
    checkbox(options.render(), "Select depot 200").props.onChange({ target: { checked: false } });
    button(options.render(), "Fetch previous versions").props.onClick(); await options.settle();
    assert.deepEqual(context.calls.at(-1), ["history", "10", ["100"], false]);
    assert.equal(find(options.render(), node => node.props["aria-label"] === "Manifest ID for depot 100").props.value, "");
    assert.ok(find(options.render(), node => node.props.role === "status" && node.props.children === "SteamDB requires browser verification."));
    button(options.render(), "Fetch previous versions").props.onClick(); await options.settle();
    assert.equal(context.calls.filter(call => call[0] === "history").length, 1);
    button(options.render(), "Open SteamDB").props.onClick(); assert.deepEqual(context.calls.at(-1), ["open-history", "10", "100"]);
    buttonByLabel(options.render(), `Use manifest ${historical} for depot 100`).props.onClick();
    find(options.render(), node => node.type === "button" && node.props.className === "btn primary").props.onClick(); await options.settle();
    assert.deepEqual(context.calls.at(-1)[1].depots, [{ depotId: "100", manifestId: historical }]);
    buttonByLabel(options.render(), "Reload previous Steam versions").props.onClick(); await options.settle();
    assert.deepEqual(context.calls.at(-1), ["history", "10", ["100"], true]);
    assert.equal(find(options.render(), node => node.props["aria-label"] === "Manifest ID for depot 100").props.value, historical);
  } finally { options?.close(); context.close(); }
});

test("architecture choices use evidence and Apple Silicon retains shared 64-bit depots", async () => {
  const context = setup(); let options;
  try {
    context.view.render(); await context.view.settle();
    context.api.steamVersions = async () => ({ appId: "10", name: "Example", platforms: ["macos"], branches: [{ id: "public", name: "public" }], history: [],
      architectures: { macos: ["64", "arm64"] }, architectureLabels: { macos: { "64": "64-bit (CPU not specified)", arm64: "Apple Silicon" } },
      depots: [{ id: 100, name: "Shared Mac bundle", platforms: ["macos"], architectures: ["64"], architectureBits: ["64"], architectureCpu: [], languages: [], manifests: { public: { id: "900" } }, encryptedBranches: [] }] });
    context.publish({ ...context.state, connection: { status: "connected" }, library: [{ appId: "10", name: "Example", platforms: ["macos"], shared: false }] });
    find(context.view.render(), node => node.props.className === "steamLibraryButton").props.onClick(); await context.view.settle();
    const child = find(context.view.render(), node => node.props.versions && node.props.game);
    options = harness(child.type, child.props);
    const architecture = () => select(options.render(), "Steam download architecture");
    assert.deepEqual(React.Children.toArray(architecture().props.children).map(node => node.props.value), ["all", "64", "arm64"]);
    architecture().props.onChange({ target: { value: "arm64" } });
    assert.ok(checkbox(options.render(), "Select depot 100"));
    find(options.render(), node => node.type === "button" && node.props.className === "btn primary").props.onClick(); await options.settle();
    assert.equal(context.calls.at(-1)[1].architecture, "arm64");
    assert.equal(depotMatchesArchitecture({ architectures: ["64"], architectureBits: ["64"], architectureCpu: ["arm64"] }, "64"), true);
    assert.equal(depotMatchesArchitecture({ architectures: ["64"], architectureBits: ["64"], architectureCpu: ["x86_64"] }, "arm64"), false);
    assert.equal(depotMatchesArchitecture({ architectures: [] }, "arm64"), true);
  } finally { options?.close(); context.close(); }
});

test("universal architecture labels stay compact and preserve full descriptions in tooltips", async () => {
  const context = setup([{ ...game("1", "Universal game"), architectures: ["64", "arm64", "universal"], architectureLabel: "Universal (Intel and Apple Silicon)" },
    { ...game("2", "Intel game"), architectures: ["64"], architectureLabel: "Intel 64-bit" },
    { ...game("3", "Apple game"), architectures: ["arm64"], architectureLabel: "Apple Silicon" }]);
  try {
    context.view.render(); await context.view.settle();
    const labels = elements(context.view.render()).filter(node => node.props.className === "steamArchitectureLabel");
    assert.deepEqual(labels.map(node => node.props.children), ["Apple Silicon", "Intel 64-bit", "Universal"]);
    assert.equal(labels.at(-1).props.title, "Universal (Intel and Apple Silicon)");
  } finally { context.close(); }
});

test("itch.io public URLs work without keys and only Add game starts a connection", async () => {
  const context = setup(); let provider, options;
  try {
    context.view.render(); await context.view.settle();
    find(context.view.render(), node => node.props.id === "steam-itch-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "itch" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    const publicMode = () => find(provider.render(), node => node.type === "input" && node.props.name === "itch-library-mode" && node.props.value === "public");
    assert.equal(publicMode().props.checked, true);
    assert.equal(find(provider.render(), node => node.props["aria-label"] === "itch.io API key"), undefined);
    const url = () => find(provider.render(), node => node.props["aria-label"] === "itch.io game URL");
    assert.ok(url()); assert.equal(button(provider.render(), "Add game").props.disabled, true);
    assert.equal(context.calls.some(call => ["external-connect", "external-add-game", "external-library", "external-versions"].includes(call[0])), false);
    url().props.onChange({ target: { value: "https://example.itch.io/game" } });
    await find(provider.render(), node => node.type === "form" && node.props.className === "externalPublicGameForm").props.onSubmit({ preventDefault() {} });
    assert.deepEqual(context.calls.slice(-2), [["external-connect", "itch", { mode: "public" }], ["external-add-game", "itch", "https://example.itch.io/game"]]);
    assert.equal(url().props.value, "");
    assert.ok(find(provider.render(), node => node.props.role === "status" && node.props.children === "Game added."));
    assert.equal(context.calls.some(call => call[0] === "external-versions"), false);
    find(provider.render(), node => node.props.className === "steamLibraryButton").props.onClick(); await provider.settle();
    const child = find(provider.render(), node => node.props.versions && node.props.game);
    options = harness(child.type, child.props);
    const download = find(options.render(), node => node.type === "button" && node.props.className === "btn primary");
    download.props.onClick(); await options.settle();
    assert.equal(context.calls.at(-1)[0], "external-download"); assert.equal(context.calls.at(-1)[1], "itch");
    assert.equal(context.calls.at(-1)[2].autoImport, true);
    url().props.onChange({ target: { value: "https://example.itch.io/another" } });
    await find(provider.render(), node => node.type === "form" && node.props.className === "externalPublicGameForm").props.onSubmit({ preventDefault() {} });
    assert.equal(context.calls.filter(call => call[0] === "external-connect").length, 1);
  } finally { options?.close(); provider?.close(); context.close(); }
});

test("itch.io mode selection stays offline, keeps account games separate and displays public access errors", async () => {
  const context = setup(); let provider;
  try {
    context.view.render(); await context.view.settle();
    find(context.view.render(), node => node.props.id === "steam-itch-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "itch" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    context.publishExternal("itch", { ...context.state, hasSavedKey: true, connection: { status: "connected", mode: "manual", accountName: "account" },
      library: [{ appId: "owned-game", name: "Account game", platforms: ["macos"], shared: false }] });
    assert.equal(find(provider.render(), node => node.props.className === "steamLibraryButton"), undefined);
    find(provider.render(), node => node.type === "input" && node.props.name === "itch-library-mode" && node.props.value === "account").props.onChange();
    assert.ok(find(provider.render(), node => node.props.className === "steamLibraryButton"));
    find(provider.render(), node => node.type === "input" && node.props.name === "itch-library-mode" && node.props.value === "public").props.onChange();
    assert.equal(find(provider.render(), node => node.props.className === "steamLibraryButton"), undefined);
    assert.equal(context.calls.some(call => ["external-connect", "external-add-game", "external-library"].includes(call[0])), false);
    context.api.externalAddGame = async () => { throw new Error("This game requires account access."); };
    find(provider.render(), node => node.props["aria-label"] === "itch.io game URL").props.onChange({ target: { value: "https://example.itch.io/paid-game" } });
    await find(provider.render(), node => node.type === "form" && node.props.className === "externalPublicGameForm").props.onSubmit({ preventDefault() {} });
    const error = find(provider.render(), node => typeof node.type === "function" && node.props.text === "This game requires account access.");
    assert.ok(error);
    assert.equal(find(provider.render(), node => node.props["aria-label"] === "itch.io game URL").props.value, "https://example.itch.io/paid-game");
  } finally { provider?.close(); context.close(); }
});

test("itch.io can reopen a saved public library without adding a URL or reading a key", async () => {
  const context = setup(); let provider;
  try {
    context.view.render(); await context.view.settle();
    find(context.view.render(), node => node.props.id === "steam-itch-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "itch" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    context.api.externalConnect = async (store, credentials) => { context.calls.push(["external-connect", store, credentials]); return { ...context.state, connection: { status: "connected", mode: "public", displayName: "Public games" }, library: [{ appId: "saved-game", name: "Saved public game", platforms: ["macos"], shared: false }] }; };
    button(provider.render(), "Open public library").props.onClick(); await provider.settle();
    assert.deepEqual(context.calls.at(-1), ["external-connect", "itch", { mode: "public" }]);
    assert.ok(find(provider.render(), node => node.props.className === "steamLibraryButton"));
    assert.equal(context.calls.some(call => ["external-add-game", "external-library", "external-login", "external-versions"].includes(call[0])), false);
  } finally { provider?.close(); context.close(); }
});

test("Google Play opens offline and uses native browser sign-in, saved sessions and pending-window controls", async () => {
  const context = setup(); let provider;
  try {
    context.view.render(); await context.view.settle();
    find(context.view.render(), node => node.props.id === "steam-google-play-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "google-play" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    assert.deepEqual(context.calls.slice(-2), [["external-state", "google-play"], ["external-accounts", "google-play", false]]);
    assert.equal(context.calls.some(call => ["external-connect", "external-login", "external-library", "external-search"].includes(call[0])), false);
    assert.equal(find(provider.render(), node => node.type === "input" && ["password", "email"].includes(node.props.type)), undefined);
    assert.equal(button(provider.render(), "Use selected account").props.disabled, true);
    assert.equal(button(provider.render(), "Sign in in browser").props.type, "submit");
    assert.equal(button(provider.render(), "Sign in in browser").props.className, "btn primary");
    assert.equal(find(provider.render(), node => node.type === "details" && React.Children.toArray(node.props.children).some(child => React.isValidElement(child) && child.type === "summary" && child.props.children === "Browser sign-in")), undefined);
    await find(provider.render(), node => node.type === "form" && node.props.className === "steamLoginForm").props.onSubmit({ preventDefault() {} }); await provider.settle();
    assert.deepEqual(context.calls.at(-1), ["external-connect", "google-play", { mode: "browser", remember: true }]);
    context.publishExternal("google-play", { ...context.state, hasSavedSession: true, connection: { status: "disconnected" } }); provider.render();
    button(provider.render(), "Use saved sign-in").props.onClick(); await provider.settle();
    assert.deepEqual(context.calls.at(-1), ["external-connect", "google-play", { mode: "reuse" }]);
    context.publishExternal("google-play", { ...context.state, hasSavedSession: true, connection: { status: "guard", mode: "browser", guard: { kind: "authorization", message: "Complete Google sign-in in the Google window." } } });
    assert.ok(find(provider.render(), node => node.props.role === "status"));
    button(provider.render(), "Open Google window").props.onClick(); assert.deepEqual(context.calls.at(-1), ["external-login", "google-play"]);
    button(provider.render(), "Cancel sign-in").props.onClick(); assert.deepEqual(context.calls.at(-1), ["external-disconnect", "google-play"]);
    assert.equal(context.calls.filter(call => call[0] === "external-connect").length, 2);
  } finally { provider?.close(); context.close(); }
});

test("Google Play store searches are explicit, cached separately from owned games and locally filterable", async () => {
  const context = setup(); let provider;
  try {
    context.view.render(); await context.view.settle();
    find(context.view.render(), node => node.props.id === "steam-google-play-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "google-play" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    context.publishExternal("google-play", { ...context.state, hasSavedSession: true, capabilities: { search: true, ownedLibrary: true }, connection: { status: "connected", mode: "browser", accountName: "account" }, library: [{ appId: "com.owned.game", name: "Owned Android game", platforms: ["android"], shared: false, owned: true }] });
    provider.render(); provider.render();
    assert.equal(find(provider.render(), node => node.props.className === "steamLibraryButton"), undefined);
    const query = () => find(provider.render(), node => node.props["aria-label"] === "Google Play store query");
    query().props.onChange({ target: { value: "https://play.google.com/store/apps/details?id=com.example.game" } });
    assert.equal(context.calls.some(call => call[0] === "external-search"), false);
    await find(provider.render(), node => node.type === "form" && node.props.className === "externalStoreSearchForm").props.onSubmit({ preventDefault() {} });
    assert.deepEqual(context.calls.at(-1), ["external-search", "google-play", "https://play.google.com/store/apps/details?id=com.example.game"]);
    assert.equal(find(provider.render(), node => node.props.className === "steamGameName").props.children, "Android example");
    find(provider.render(), node => typeof node.type === "function" && node.type.name === "LibrarySearch").props.onQueryChange("missing");
    assert.equal(find(provider.render(), node => node.props.className === "steamLibraryButton"), undefined);
    assert.equal(context.calls.filter(call => call[0] === "external-search").length, 1);
    button(provider.render(), "Clear filters").props.onClick();
    find(provider.render(), node => node.type === "input" && node.props.name === "google-play-library-scope" && node.props.value === "owned").props.onChange();
    assert.equal(find(provider.render(), node => node.props.className === "steamGameName").props.children, "Owned Android game");
    buttonByLabel(provider.render(), "Reload Google Play library").props.onClick(); assert.deepEqual(context.calls.at(-1), ["external-library", "google-play", true]);
    find(provider.render(), node => node.type === "input" && node.props.name === "google-play-library-scope" && node.props.value === "search").props.onChange();
    assert.equal(find(provider.render(), node => node.props.className === "steamGameName").props.children, "Android example");
    button(provider.render(), "Forget sign-in").props.onClick(); assert.deepEqual(context.calls.at(-1), ["external-forget", "google-play"]);
    context.api.externalSearch = async () => { throw new Error("Google Play search is unavailable."); };
    await find(provider.render(), node => node.type === "form" && node.props.className === "externalStoreSearchForm").props.onSubmit({ preventDefault() {} });
    assert.ok(find(provider.render(), node => typeof node.type === "function" && node.props.text === "Google Play search is unavailable."));
  } finally { provider?.close(); context.close(); }
});

test("Google Play downloads preserve exact version codes, Android ABI, extra files and import choices", async () => {
  const context = setup(); let provider, options;
  try {
    context.api.externalVersions = async () => ({ appId: "com.example.game", name: "Android example", platforms: ["android"], branches: [{ id: "1024", name: "1.2.0", buildId: "1024", versionCode: "1024", platforms: ["android"] }],
      depots: [], history: [], architectures: ["arm64", "armv7", "x86_64", "x86"], languages: ["en-US"], supportsVersionCode: true, historyNote: "Only the current release is listed. A known earlier version code can be requested." });
    context.view.render(); await context.view.settle();
    find(context.view.render(), node => node.props.id === "steam-google-play-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "google-play" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    context.publishExternal("google-play", { ...context.state, connection: { status: "connected", mode: "browser", accountName: "account" } }); provider.render(); provider.render();
    find(provider.render(), node => node.props["aria-label"] === "Google Play store query").props.onChange({ target: { value: "com.example.game" } });
    await find(provider.render(), node => node.type === "form" && node.props.className === "externalStoreSearchForm").props.onSubmit({ preventDefault() {} });
    find(provider.render(), node => node.props.className === "steamLibraryButton").props.onClick(); await provider.settle();
    const child = find(provider.render(), node => node.props.versions && node.props.game);
    options = harness(child.type, child.props);
    const download = () => find(options.render(), node => node.type === "button" && node.props.className === "btn primary");
    assert.equal(select(options.render(), "Google Play download platform").props.value, "android");
    assert.equal(select(options.render(), "Google Play download architecture").props.value, "arm64");
    assert.match(React.Children.toArray(select(options.render(), "Google Play download version").props.children)[0].props.children, /1.2.0.*Build 1024/);
    download().props.onClick(); await options.settle();
    assert.equal(context.calls.at(-1)[2].includeExtras, true); assert.equal(context.calls.at(-1)[2].autoImport, true);
    const version = () => find(options.render(), node => node.props["aria-label"] === "Google Play version code");
    version().props.onChange({ target: { value: "old release" } }); assert.equal(download().props.disabled, true);
    version().props.onChange({ target: { value: "1000" } });
    select(options.render(), "Google Play download architecture").props.onChange({ target: { value: "x86" } });
    const checks = () => elements(options.render()).filter(node => node.type === "label" && node.props.className === "steamInlineCheck");
    checks().find(node => React.Children.toArray(node.props.children).includes("Include expansion files and asset packs")).props.children[0].props.onChange({ target: { checked: false } });
    checks().find(node => React.Children.toArray(node.props.children).includes("Import into MacLauncher when the download finishes")).props.children[0].props.onChange({ target: { checked: false } });
    button(options.render(), "Choose folder…").props.onClick(); await options.settle();
    download().props.onClick(); await options.settle();
    assert.deepEqual(context.calls.at(-1), ["external-download", "google-play", { appId: "com.example.game", name: "Android example", platform: "android", branch: "1000", versionCode: "1000", architecture: "x86", language: "en-US", includeExtras: false, androidSdk: 34, autoImport: false, destination: "/Custom downloads" }]);
  } finally { options?.close(); provider?.close(); context.close(); }
});

test("Google Play ABI changes resolve the selected device profile without resetting a known version code", async () => {
  const context = setup(); let provider, options;
  try {
    const version = (code, abi) => ({ appId: "com.example.game", name: "Android example", platforms: ["android"], branches: [{ id: code, name: "1.2.0", buildId: code, versionCode: code, architectures: [abi], platforms: ["android"] }], depots: [], history: [], architectures: ["arm64", "x86"], languages: ["en-US"], supportsVersionCode: true });
    context.api.externalVersions = async (store, id, refresh, profile) => { context.calls.push(["external-versions", store, id, refresh, profile]); return version(profile?.architecture === "x86" ? "2048" : "1024", profile?.architecture || "arm64"); };
    context.view.render(); await context.view.settle();
    find(context.view.render(), node => node.props.id === "steam-google-play-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "google-play" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    context.publishExternal("google-play", { ...context.state, connection: { status: "connected", mode: "browser", accountName: "account" } }); provider.render(); provider.render();
    find(provider.render(), node => node.props["aria-label"] === "Google Play store query").props.onChange({ target: { value: "com.example.game" } });
    await find(provider.render(), node => node.type === "form" && node.props.className === "externalStoreSearchForm").props.onSubmit({ preventDefault() {} });
    find(provider.render(), node => node.props.className === "steamLibraryButton").props.onClick(); await provider.settle();
    const child = find(provider.render(), node => node.props.versions && node.props.game);
    options = harness(child.type, child.props);
    find(options.render(), node => node.props["aria-label"] === "Google Play version code").props.onChange({ target: { value: "1000" } });
    select(options.render(), "Google Play download architecture").props.onChange({ target: { value: "x86" } });
    const download = () => find(options.render(), node => node.type === "button" && node.props.className === "btn primary");
    assert.equal(download().props.disabled, true);
    assert.deepEqual(context.calls.at(-1), ["external-versions", "google-play", "com.example.game", false, { architecture: "x86", language: "en-US", androidSdk: 34 }]);
    await options.settle();
    assert.equal(select(options.render(), "Google Play download version").props.value, "2048");
    assert.equal(find(options.render(), node => node.props["aria-label"] === "Google Play version code").props.value, "1000");
    assert.ok(find(options.render(), node => node.props.role === "status" && typeof node.props.children === "string" && /Version changed.*2048/.test(node.props.children)));
    download().props.onClick(); await options.settle();
    assert.equal(context.calls.at(-1)[2].branch, "1000"); assert.equal(context.calls.at(-1)[2].architecture, "x86");
    buttonByLabel(options.render(), "Reload Google Play versions").props.onClick(); await options.settle();
    assert.deepEqual(context.calls.at(-1), ["external-versions", "google-play", "com.example.game", true, { architecture: "x86", language: "en-US", androidSdk: 34 }]);
  } finally { options?.close(); provider?.close(); context.close(); }
});

test("Google Play defaults to browser sign-in and can explicitly reuse shared accounts without opening Android sign-in", async () => {
  const context = setup(); let provider;
  try {
    context.view.render(); await context.view.settle();
    find(context.view.render(), node => node.props.id === "steam-google-play-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "google-play" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    assert.equal(button(provider.render(), "Use selected account").props.disabled, true);
    assert.deepEqual(context.calls.filter(call => call[0] === "external-accounts"), [["external-accounts", "google-play", false]]);
    assert.equal(context.calls.some(call => call[0] === "external-connect"), false);
    buttonByLabel(provider.render(), "Reload shared Google accounts").props.onClick(); await provider.settle(); provider.render();
    assert.deepEqual(context.calls.at(-1), ["external-accounts", "google-play", true]);
    const account = () => select(provider.render(), "Google Play shared account");
    assert.equal(account().props.value, "shared:available");
    assert.equal(React.Children.toArray(account().props.children).find(node => node.props.value === "shared:cached").props.disabled, true);
    assert.equal(button(provider.render(), "Use selected account").props.disabled, false);
    button(provider.render(), "Google account settings").props.onClick(); assert.deepEqual(context.calls.at(-1), ["external-account-settings", "google-play"]);
    button(provider.render(), "Use selected account").props.onClick(); await provider.settle();
    assert.deepEqual(context.calls.at(-1), ["external-connect", "google-play", { mode: "microg", accountId: "shared:available" }]);
    assert.equal(context.calls.some(call => call[0] === "external-login"), false);
    context.publishExternal("google-play", { ...context.state, connection: { status: "guard", mode: "microg", guard: { kind: "authorization", message: "Complete the account request in microG." } } });
    button(provider.render(), "Open account settings").props.onClick(); assert.deepEqual(context.calls.at(-1), ["external-account-settings", "google-play"]);
    assert.equal(button(provider.render(), "Open Google window"), undefined);
  } finally { provider?.close(); context.close(); }
});

test("Google Play restores cached shared account names without a live account-manager refresh", async () => {
  const context = setup(); let provider;
  try {
    context.api.externalAccounts = async (store, refresh) => { context.calls.push(["external-accounts", store, refresh]); return { accounts: [{ id: "shared:cached-ready", label: "Existing account", source: "microG", available: true }], providers: [] }; };
    context.view.render(); await context.view.settle();
    find(context.view.render(), node => node.props.id === "steam-google-play-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "google-play" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle(); provider.render();
    assert.equal(select(provider.render(), "Google Play shared account").props.value, "shared:cached-ready");
    assert.deepEqual(context.calls.filter(call => call[0] === "external-accounts"), [["external-accounts", "google-play", false]]);
    assert.equal(context.calls.some(call => ["external-connect", "external-login", "external-library", "external-search"].includes(call[0])), false);
    button(provider.render(), "Use selected account").props.onClick(); await provider.settle();
    assert.deepEqual(context.calls.at(-1), ["external-connect", "google-play", { mode: "microg", accountId: "shared:cached-ready" }]);
  } finally { provider?.close(); context.close(); }
});

test("Google Play focus reads cached account names offline and serializes with explicit refresh", async () => {
  const context = setup(); let provider;
  try {
    context.view.render(); await context.view.settle();
    find(context.view.render(), node => node.props.id === "steam-google-play-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "google-play" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    const pending = [];
    let inFlight = 0, maximum = 0;
    context.api.externalAccounts = (store, refresh) => {
      context.calls.push(["external-accounts", store, refresh]); inFlight++; maximum = Math.max(maximum, inFlight);
      return new Promise(resolve => pending.push(accounts => { inFlight--; resolve({ accounts, providers: [] }); }));
    };
    const focus = context.listeners.focus;
    focus(); await provider.settle();
    assert.deepEqual(context.calls.at(-1), ["external-accounts", "google-play", false]);
    focus();
    buttonByLabel(provider.render(), "Reload shared Google accounts").props.onClick(); await provider.settle();
    assert.equal(inFlight, 1); assert.equal(pending.length, 1);
    pending.shift()([{ id: "shared:new", label: "Newly signed-in account", source: "microG", available: true }]);
    await provider.settle(); provider.render();
    assert.equal(select(provider.render(), "Google Play shared account").props.value, "shared:new");
    assert.deepEqual(context.calls.at(-1), ["external-accounts", "google-play", false]);
    assert.equal(inFlight, 1);
    pending.shift()([{ id: "shared:new", label: "Newly signed-in account", source: "microG", available: true }]);
    await provider.settle();
    assert.deepEqual(context.calls.at(-1), ["external-accounts", "google-play", true]);
    pending.shift()([{ id: "shared:new", label: "Newly signed-in account", source: "microG", available: true }]);
    await provider.settle(); assert.equal(maximum, 1);
    const count = context.calls.filter(call => call[0] === "external-accounts").length;
    provider.close(); assert.equal(context.listeners.focus, undefined);
    focus(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.calls.filter(call => call[0] === "external-accounts").length, count);
    assert.equal(context.calls.some(call => ["external-connect", "external-search", "external-login", "external-library"].includes(call[0])), false);
  } finally { provider?.close(); context.close(); }
});

test("Google Play API levels are independent of ABI and unavailable profiles retain exact manual versions", async () => {
  const context = setup(); let provider, options;
  try {
    const version = (architecture = "arm64", androidSdk = 34) => ({ appId: "com.example.game", name: "Android example", platforms: ["android"],
      branches: architecture === "armv7" && androidSdk === 34 ? [] : [{ id: androidSdk === 25 ? "500" : "1024", name: "Release", buildId: androidSdk === 25 ? "500" : "1024", architectures: [architecture], platforms: ["android"] }],
      depots: [], history: [], architectures: ["arm64"], languages: ["en-US"], supportsVersionCode: true, profile: { architecture, androidSdk }, sdkVersions: [34, 25],
      deviceProfiles: [{ architecture: "arm64", androidSdk, label: "ARM 64-bit", available: true }, { architecture: "armv7", androidSdk, label: "ARM 32-bit", available: architecture === "armv7" ? androidSdk === 25 : null }],
      available: !(architecture === "armv7" && androidSdk === 34), unavailableReason: architecture === "armv7" && androidSdk === 34 ? "This release is unavailable for ARM 32-bit on API 34." : undefined });
    context.api.externalVersions = async (store, id, refresh, profile) => { context.calls.push(["external-versions", store, id, refresh, profile]); return version(profile?.architecture, profile?.androidSdk); };
    context.view.render(); await context.view.settle(); find(context.view.render(), node => node.props.id === "steam-google-play-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "google-play" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    context.publishExternal("google-play", { ...context.state, connection: { status: "connected", mode: "microg", accountName: "account" } }); provider.render(); provider.render();
    find(provider.render(), node => node.props["aria-label"] === "Google Play store query").props.onChange({ target: { value: "com.example.game" } });
    await find(provider.render(), node => node.type === "form" && node.props.className === "externalStoreSearchForm").props.onSubmit({ preventDefault() {} });
    find(provider.render(), node => node.props.className === "steamLibraryButton").props.onClick(); await provider.settle();
    const child = find(provider.render(), node => node.props.versions && node.props.game); options = harness(child.type, child.props);
    select(options.render(), "Google Play download architecture").props.onChange({ target: { value: "armv7" } }); await options.settle();
    assert.deepEqual(context.calls.at(-1).at(-1), { architecture: "armv7", language: "en-US", androidSdk: 34 });
    assert.ok(find(options.render(), node => node.props.role === "status" && node.props.children === "This release is unavailable for ARM 32-bit on API 34."));
    const download = () => find(options.render(), node => node.type === "button" && node.props.className === "btn primary");
    assert.equal(download().props.disabled, true);
    find(options.render(), node => node.props["aria-label"] === "Google Play version code").props.onChange({ target: { value: "400" } });
    assert.equal(download().props.disabled, false);
    select(options.render(), "Google Play Android API level").props.onChange({ target: { value: "25" } }); await options.settle();
    assert.equal(select(options.render(), "Google Play download version").props.value, "500");
    assert.equal(find(options.render(), node => node.props["aria-label"] === "Google Play version code").props.value, "400");
    download().props.onClick(); await options.settle();
    assert.equal(context.calls.at(-1)[2].architecture, "armv7"); assert.equal(context.calls.at(-1)[2].androidSdk, 25); assert.equal(context.calls.at(-1)[2].versionCode, "400");
    context.api.externalVersions = async () => { throw new Error("Error invoking remote method 'external:versions': Error: This profile is unavailable."); };
    buttonByLabel(options.render(), "Reload Google Play versions").props.onClick(); await options.settle();
    assert.ok(find(options.render(), node => typeof node.type === "function" && node.props.text === "This profile is unavailable."));
  } finally { options?.close(); provider?.close(); context.close(); }
});

test("Google Play adds only confirmed free apps to the library and waits for server ownership confirmation", async () => {
  const context = setup(); let provider, options;
  try {
    context.api.externalVersions = async () => ({ appId: "com.example.game", name: "Android example", platforms: ["android"], branches: [{ id: "1024", name: "Release", buildId: "1024", platforms: ["android"] }], depots: [], history: [], architectures: ["arm64"], languages: ["en-US"], supportsVersionCode: true,
      app: { appId: "com.example.game", name: "Android example", platforms: ["android"], shared: false, owned: false, priceMicros: "0", checkoutRequired: false, canAddToLibrary: true } });
    context.view.render(); await context.view.settle(); find(context.view.render(), node => node.props.id === "steam-google-play-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "google-play" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    context.publishExternal("google-play", { ...context.state, connection: { status: "connected", mode: "microg", accountName: "account" } }); provider.render(); provider.render();
    find(provider.render(), node => node.props["aria-label"] === "Google Play store query").props.onChange({ target: { value: "com.example.game" } });
    await find(provider.render(), node => node.type === "form" && node.props.className === "externalStoreSearchForm").props.onSubmit({ preventDefault() {} });
    find(provider.render(), node => node.props.className === "steamLibraryButton").props.onClick(); await provider.settle();
    const child = find(provider.render(), node => node.props.versions && node.props.game); options = harness(child.type, child.props);
    assert.equal(child.props.game.priceMicros, "0");
    let confirm;
    context.api.externalAddToLibrary = (store, appId, profile) => { context.calls.push(["external-add-to-library", store, appId, profile]); return new Promise(resolve => { confirm = resolve; }); };
    button(options.render(), "Add to library").props.onClick();
    assert.ok(button(options.render(), "Adding…").props.disabled);
    assert.equal(find(options.render(), node => node.props.className === "steamBadge imported" && node.props.children === "Owned"), undefined);
    assert.equal(context.calls.some(call => call[0] === "external-download"), false);
    confirm({ ...context.state, connection: { status: "connected", mode: "microg", accountName: "account" }, library: [{ appId: "com.example.game", name: "Android example", platforms: ["android"], shared: false, owned: true }] });
    await options.settle(); provider.render();
    assert.ok(find(options.render(), node => node.props.className === "steamBadge imported" && node.props.children === "Owned"));
    assert.ok(find(provider.render(), node => node.props.className === "steamBadge imported" && node.props.children === "Owned"));
    assert.deepEqual(context.calls.at(-1), ["external-add-to-library", "google-play", "com.example.game", { architecture: "arm64", language: "en-US", androidSdk: 34 }]);
    for (const app of [{ priceMicros: "1000000", checkoutRequired: true, canAddToLibrary: false }, { priceMicros: null, checkoutRequired: false, canAddToLibrary: false }]) {
      const other = harness(child.type, { ...child.props, versions: { ...child.props.versions, app: { ...child.props.versions.app, ...app } } });
      assert.equal(button(other.render(), "Add to library"), undefined); other.close();
    }
  } finally { options?.close(); provider?.close(); context.close(); }
});

test("Android search streams independent sources while Google Play is disconnected and ignores superseded results", async () => {
  const context = setup(); let provider;
  const pending = [];
  try {
    context.api.externalSearch = (store, query, options) => new Promise(resolve => { pending.push({ query, options, resolve }); context.calls.push(["external-search", store, query, options]); });
    context.view.render(); await context.view.settle();
    assert.ok(button(context.view.render(), "Android"));
    find(context.view.render(), node => node.props.id === "steam-google-play-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "google-play" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    assert.equal(context.calls.some(call => call[0] === "external-search"), false);
    assert.ok(find(provider.render(), node => node.props.className === "externalStoreSearchForm"));
    const query = () => find(provider.render(), node => node.props["aria-label"] === "Google Play store query");
    const submit = () => find(provider.render(), node => node.props.className === "externalStoreSearchForm").props.onSubmit({ preventDefault() {} });
    query().props.onChange({ target: { value: "example" } }); const first = submit();
    const fdroid = { appId: "fdroid:org.example.app", packageName: "org.example.app", name: "F-Droid example", platforms: ["android"], shared: false, source: "fdroid", sourceLabel: "F-Droid" };
    context.publishExternal("google-play", { ...context.state, search: { requestId: pending[0].options.requestId, query: "example", results: [fdroid], loading: true, sources: [{ id: "google-play", label: "Google Play", status: "skipped" }, { id: "fdroid", label: "F-Droid", status: "completed" }, { id: "izzy", label: "IzzyOnDroid", status: "loading" }] } });
    assert.ok(find(provider.render(), node => node.props.className === "steamGameName" && node.props.children === "F-Droid example"));
    assert.equal(query().props.disabled, undefined);
    assert.ok(find(provider.render(), node => node.props.className === "externalSearchSource loading"));
    tagCheckbox(provider.render(), "Filter Android sources: F-Droid").props.onChange({ target: { checked: false } });
    assert.equal(find(provider.render(), node => node.props.className === "steamLibraryButton"), undefined);
    button(provider.render(), "Clear filters").props.onClick();
    query().props.onChange({ target: { value: "izzy:org.second.app" } }); const second = submit();
    const izzy = { ...fdroid, appId: "izzy:org.second.app", packageName: "org.second.app", name: "Izzy example", source: "izzy", sourceLabel: "IzzyOnDroid" };
    context.publishExternal("google-play", { ...context.state, search: { requestId: pending[1].options.requestId, query: "izzy:org.second.app", results: [izzy], loading: false, sources: [{ id: "izzy", label: "IzzyOnDroid", status: "completed" }] } });
    context.publishExternal("google-play", { ...context.state, search: { requestId: pending[0].options.requestId, query: "example", results: [fdroid], loading: false, sources: [{ id: "fdroid", label: "F-Droid", status: "completed" }] } });
    pending[0].resolve([fdroid]); await first;
    assert.ok(find(provider.render(), node => node.props.className === "steamGameName" && node.props.children === "Izzy example"));
    pending[1].resolve([izzy]); await second;
    assert.ok(find(provider.render(), node => node.props.className === "steamGameMeta" && node.props.children === "org.second.app"));
    assert.equal(context.calls.some(call => call[0] === "external-connect"), false);
  } finally { provider?.close(); context.close(); }
});

test("Android F-Droid versions preserve exact APK builds and use source-specific download folders", async () => {
  const context = setup(); let provider, options;
  const app = { appId: "fdroid:org.example.app", packageName: "org.example.app", name: "F-Droid example", platforms: ["android"], shared: false, source: "fdroid", sourceLabel: "F-Droid" };
  try {
    context.api.externalSearch = async () => [app];
    context.api.externalVersions = async (store, id) => ({ appId: id, name: app.name, platforms: ["android"], branches: [{ id: "incompatible-arm64", name: "2.0", buildId: "200", platforms: ["android"], architectures: ["arm64"], minSdk: 35 }, { id: "apk-sha256", name: "1.2", buildId: "102", versionCode: "102", platforms: ["android"], architectures: ["armv7"], minSdk: 23, maxSdk: 34 }], depots: [], history: [], architectures: ["armv7"], languages: ["en-US"], source: "fdroid", sourceLabel: "F-Droid", defaultDirectory: "/Profile/external/downloads/fdroid", profile: { architecture: "armv7", androidSdk: 34 }, sdkVersions: [34], supportsVersionCode: false });
    context.view.render(); await context.view.settle(); find(context.view.render(), node => node.props.id === "steam-google-play-tab").props.onClick();
    const component = find(context.view.render(), node => node.props.store === "google-play" && node.props.onImported);
    provider = harness(component.type, component.props); provider.render(); await provider.settle();
    find(provider.render(), node => node.props["aria-label"] === "Google Play store query").props.onChange({ target: { value: "fdroid:org.example.app" } });
    await find(provider.render(), node => node.props.className === "externalStoreSearchForm").props.onSubmit({ preventDefault() {} });
    find(provider.render(), node => node.props.className === "steamLibraryButton").props.onClick(); await provider.settle();
    const child = find(provider.render(), node => node.props.versions && node.props.game); options = harness(child.type, child.props);
    assert.equal(select(options.render(), "F-Droid download version").props.value, "apk-sha256");
    assert.equal(find(options.render(), node => node.props["aria-label"] === "Google Play version code"), undefined);
    assert.equal(button(options.render(), "Add to library"), undefined);
    assert.equal(find(options.render(), node => node.props.className === "externalControlHelp externalAndroidExtras"), undefined);
    assert.ok(find(options.render(), node => node.props.className === "steamDestinationPath" && node.props.children === "/Profile/external/downloads/fdroid"));
    button(options.render(), "Open default in Finder").props.onClick(); assert.deepEqual(context.calls.at(-1), ["open-downloads", "fdroid"]);
    find(options.render(), node => node.type === "button" && node.props.className === "btn primary").props.onClick(); await options.settle();
    const selection = context.calls.at(-1)[2]; assert.equal(selection.appId, app.appId); assert.equal(selection.branch, "apk-sha256"); assert.equal(selection.architecture, "armv7"); assert.equal(selection.androidSdk, 34); assert.equal(selection.includeExtras, undefined); assert.equal(selection.autoImport, true);
  } finally { options?.close(); provider?.close(); context.close(); }
});
