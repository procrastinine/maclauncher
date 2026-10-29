const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createSteamWindowService } = require("../src/main/steam-window-service");
const { createSteamSessionStorage } = require("../src/main/steam-session");

test("Steam scan and snapshot stay offline; imports queue in background and retain individual errors", async () => {
  let release, online = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const calls = [], changes = [];
  const service = createSteamWindowService({ userDataDir: "/profile", readGames: () => [],
    createDownloads() { online++; throw new Error("Unexpected network client"); },
    discover: async () => [
      { id: "a", name: "One", gamePath: "/one", imported: false },
      { id: "b", name: "Two", gamePath: "/two", imported: false }
    ],
    importGame: async (input, options) => { calls.push([input, options]); await waiting; if (input === "/two") throw new Error("Unsupported game format"); },
    onChange: state => changes.push(state)
  });
  assert.equal(service.snapshot().connection.status, "disconnected");
  assert.equal((await service.scan()).length, 2);
  assert.deepEqual(await service.importInstalled(["a", "b", "missing"]), { queued: ["a", "b"] });
  assert.equal(online, 0);
  assert.ok(service.snapshot().imports.every(job => ["queued", "importing"].includes(job.status)));
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [["/one", { background: true }], ["/two", { background: true }]]);
  assert.equal(service.snapshot().imports.find(job => job.name === "One").status, "completed");
  assert.match(service.snapshot().imports.find(job => job.name === "Two").error, /Unsupported/);
  assert.ok(changes.length > 1);
  await service.dispose();
});

test("Steam actions forward explicit refresh and full download choice; completed downloads import separately", async () => {
  let options, imported = [], marked = [];
  const calls = [], jobs = [{ id: "download", name: "Game", path: "/custom/game", status: "completed" }];
  const service = createSteamWindowService({ userDataDir: "/profile", readGames: () => [],
    discover: async () => [], importGame: async (input, flags) => imported.push([input, flags]),
    createDownloads: config => { options = config; return {
      snapshot: () => ({ connection: { status: "connected" }, downloads: jobs, library: [] }),
      connect: value => calls.push(["connect", value]),
      loadLibrary: value => calls.push(["library", value]),
      getVersions: (...value) => calls.push(["versions", ...value]),
      download: value => calls.push(["download", value]),
      markImported: id => marked.push(id), dispose() {}
    }; }
  });
  service.connect({ accountName: "account", remember: false });
  service.loadLibrary(true);
  service.getVersions(42, true);
  const choice = { appId: 42, platform: "linux", branch: "legacy", autoImport: false, destination: "/custom" };
  service.download(choice);
  assert.deepEqual(calls.slice(1), [["library", { refresh: true }], ["versions", 42, { refresh: true }], ["download", choice]]);
  assert.deepEqual(imported, []);
  assert.deepEqual(service.importDownload("download"), { queued: ["download"] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(imported, [["/custom/game", { background: true }]]);
  assert.deepEqual(marked, ["download"]);
  await options.onDownloaded(jobs[0]);
  assert.equal(imported.length, 2);
  assert.throws(() => service.importDownload("unknown"), /finish/);
  await service.dispose();
});

test("remembered Steam session is encrypted and private; unavailable encryption stores nothing", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "steam-session-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let available = true;
  const safeStorage = {
    isEncryptionAvailable: () => available,
    encryptString: text => Buffer.from(text.split("").reverse().join("")),
    decryptString: bytes => bytes.toString().split("").reverse().join("")
  };
  const storage = createSteamSessionStorage({ userDataDir: directory, safeStorage });
  assert.equal(await storage.loadSession(), null);
  const session = { accountName: "example", refreshToken: "private-refresh-token" };
  await storage.saveSession(session);
  const file = path.join(directory, "steam/session.enc");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.ok(!(await fs.readFile(file, "utf8")).includes(session.refreshToken));
  assert.deepEqual(await storage.loadSession(), session);
  await storage.saveSession(null);
  available = false;
  await assert.rejects(storage.saveSession(session), /Keychain/);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test('multiple manual Steam accounts coexist with desktop Steam and switch without cancelling downloads', async () => {
  const clients = new Map(), calls = [];
  function backend(options, mode) {
    const state = { connection: { status: 'disconnected', accountName: options.accountName || 'Desktop account' }, library: [], downloads: [] };
    const service = { snapshot: () => structuredClone(state),
      connect: async () => { state.connection.status = 'connected'; options.onChange(); },
      download: selection => { state.downloads.push({ id: `${options.accountName}-job`, name: 'Game', status: 'downloading', ...selection }); },
      cancel: id => calls.push(['cancel', id]), dispose: async () => calls.push(['dispose', options.accountName]),
      loadLibrary: async () => [], getVersions: async () => ({}) };
    clients.set(options.accountName || 'desktop', service); return service;
  }
  const service = createSteamWindowService({ userDataDir: '/profile', readGames: () => [], importGame: async () => {},
    discover: async () => [], createDownloads: options => backend(options, 'manual'), createClientSession: options => backend(options, 'client'),
    listAccounts: async () => [{ accountName: 'First' }, { accountName: 'Second' }],
    loadSession: async accountName => ({ accountName, refreshToken: 'encrypted-only' }), removeSession: async name => calls.push(['remove', name]) });
  await service.initialize();
  assert.equal(service.snapshot().accounts.length, 3);
  assert.equal(service.snapshot().activeAccountId, 'desktop');
  await service.connect({ mode: 'manual', accountName: 'First', password: 'not-saved' });
  service.download({ appId: 42 });
  const second = service.snapshot().accounts.find(row => row.accountName === 'Second');
  await service.selectAccount(second.id);
  assert.equal(service.snapshot().connection.accountName, 'Second');
  assert.equal(service.snapshot().downloads[0].accountName, 'First');
  assert.equal(service.snapshot().downloads[0].status, 'downloading');
  assert.deepEqual(calls, []);
  const first = service.snapshot().accounts.find(row => row.accountName === 'First');
  await assert.rejects(service.removeAccount(first.id), /Cancel/);
  await service.removeAccount(second.id);
  assert.deepEqual(calls, [['dispose', 'Second'], ['remove', 'Second']]);
  await service.dispose();
});

test('remembered account writes serialize and removal preserves other accounts', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-accounts-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() };
  const storage = createSteamSessionStorage({ userDataDir: directory, safeStorage });
  await Promise.all(['First', 'Second'].map(accountName => storage.saveSession({ accountName, refreshToken: accountName + '-token' })));
  assert.deepEqual((await storage.listAccounts()).map(row => row.accountName), ['First', 'Second']);
  await storage.removeSession('FIRST');
  assert.equal(await storage.loadSession('First'), null);
  assert.equal((await storage.loadSession('second')).refreshToken, 'Second-token');
});

test('opening External lists account labels without querying or decrypting the Keychain', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'steam-vault-lazy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let allow = false, keychainCalls = 0;
  const safeStorage = {
    isEncryptionAvailable() { keychainCalls++; assert.ok(allow, 'Opening External must not touch Keychain'); return true; },
    encryptString: text => Buffer.from(text),
    decryptString(bytes) { assert.ok(allow, 'Account listing must not decrypt credentials'); return bytes.toString(); }
  };
  const storage = createSteamSessionStorage({ userDataDir: directory, safeStorage });
  assert.deepEqual(await storage.listAccounts(), []);
  assert.equal(await storage.loadSession(), null, 'An empty vault needs no Keychain access');
  assert.equal(keychainCalls, 0);
  allow = true;
  await storage.saveSession({ accountName: 'Saved account', refreshToken: 'encrypted-token' });
  const callsAfterSave = keychainCalls;
  allow = false;
  const reopened = createSteamSessionStorage({ userDataDir: directory, safeStorage });
  const service = createSteamWindowService({ userDataDir: directory, ...reopened,
    createClientSession: () => ({ snapshot: () => ({ connection: {}, downloads: [] }), dispose() {} }),
    createDownloads: () => ({ snapshot: () => ({ connection: {}, downloads: [] }), dispose() {} }) });
  const state = await service.initialize();
  assert.equal(state.accounts[1].accountName, 'Saved account');
  assert.equal(keychainCalls, callsAfterSave);
  const indexFile = path.join(directory, 'steam/accounts.json');
  assert.equal((await fs.stat(indexFile)).mode & 0o777, 0o600);
  assert.ok(!(await fs.readFile(indexFile, 'utf8')).includes('encrypted-token'));
  await service.dispose();
  // An older encrypted vault is migrated by the next explicit sign-in.
  await fs.rm(indexFile);
  assert.deepEqual(await reopened.listAccounts(), []);
  assert.equal(keychainCalls, callsAfterSave);
  allow = true;
  assert.equal((await reopened.loadSession('Saved account')).refreshToken, 'encrypted-token');
  allow = false;
  assert.deepEqual(await reopened.listAccounts(), [{ accountName: 'Saved account' }]);
});

test('previous-version discovery stays lazy and accepts only depots belonging to the selected game', async () => {
  const requests = []; let creations = 0, disposed = false;
  const service = createSteamWindowService({ userDataDir: '/profile',
    createClientSession: () => ({ snapshot: () => ({ connection: {}, downloads: [] }), getVersions: async () => ({ depots: [{ id: 102 }] }), dispose() {} }),
    createHistory: () => { creations++; return { get: async (...args) => requests.push(args), dispose: () => { disposed = true; } }; } });
  await service.initialize(); assert.equal(creations, 0);
  await assert.rejects(service.previousVersions(101, ['103']), /depots listed/); assert.equal(creations, 0);
  await service.previousVersions(101, ['102'], true);
  assert.deepEqual(requests, [[101, ['102'], { refresh: true }]]); assert.equal(creations, 1);
  await service.dispose(); assert.equal(disposed, true);
});

test('Google account metadata contains identity without secrets and reads with a locked vault', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'google-account-metadata-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let locked = false;
  const safeStorage = { isEncryptionAvailable() { assert.equal(locked, false); return true; },
    encryptString: value => Buffer.from(value), decryptString: bytes => bytes.toString() };
  const storage = createSteamSessionStorage({ userDataDir: directory, safeStorage, namespace: 'external/google-play' });
  await storage.saveSession({ accountName: 'google-play', session: { email: 'saved@example.invalid', aasToken: 'private-token', devices: { secret: true } } });
  locked = true;
  assert.deepEqual(await storage.listAccounts(), [{ accountName: 'google-play', label: 'saved@example.invalid' }]);
  const index = await fs.readFile(path.join(directory, 'external/google-play/accounts.json'), 'utf8');
  assert.doesNotMatch(index, /private-token|aasToken|devices/);
});
