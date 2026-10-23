const test = require('node:test');
const assert = require('node:assert/strict');
const { createExternalStoreService } = require('../src/main/external-store-service');

test('external providers stay lazy, keep store state separate and open only issued trusted login URLs', async () => {
  const created = [], opened = [], states = new Map();
  const service = createExternalStoreService({ userDataDir: '/profile', openExternal: async url => opened.push(url), importGame: async () => {},
    createDownloads: options => {
      created.push(options.store); const state = { connection: { status: 'disconnected', authUrl: options.store === 'epic' ? 'https://legendary.gl/epiclogin' : 'https://auth.gog.com/auth' }, downloads: [] }; states.set(options.store, state);
      return { snapshot: () => state, dispose() {}, disconnect() {} };
    } });
  assert.deepEqual(created, []);
  assert.equal(service.hasActive(), false);
  assert.equal(service.snapshot('epic').connection.status, 'disconnected');
  assert.deepEqual(created, ['epic']);
  await service.openLogin('epic'); assert.deepEqual(opened, ['https://legendary.gl/epiclogin']);
  states.get('epic').connection.authUrl = 'https://legendary.gl.attacker.invalid/login';
  await assert.rejects(service.openLogin('epic'), /invalid/);
  await service.openLogin('itch'); assert.equal(opened.at(-1), 'https://itch.io/user/settings/api-keys');
  assert.throws(() => service.snapshot('../steam'), /Choose/);
  await service.dispose();
});

test('completed external downloads import independently and forgetting clears only the selected store', async () => {
  const imports = [], forgotten = [], configs = new Map(), records = new Map();
  const service = createExternalStoreService({ userDataDir: '/profile', importGame: async job => imports.push(job.importPath || job.path),
    createStorage: store => ({ saveSession: async value => forgotten.push([store, value]) }),
    createDownloads: options => {
      configs.set(options.store, options); const job = { id: options.store, status: 'completed', path: '/' + options.store, importPath: '/' + options.store + '/game.zip' }; records.set(options.store, job);
      return { snapshot: () => ({ connection: {}, downloads: [job] }), markImported: () => { job.imported = true; },
        disconnect() {}, dispose() {} };
    } });
  service.snapshot('itch'); service.snapshot('gog');
  assert.deepEqual(await service.importDownload('itch', 'itch'), { queued: ['itch'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(imports, ['/itch/game.zip']); assert.equal(records.get('itch').imported, true); assert.equal(records.get('gog').imported, undefined);
  await service.forget('itch'); assert.deepEqual(forgotten, [['itch', null]]);
  await service.dispose();
});

test('public itch game links forward explicitly without connecting other providers', async () => {
  const created = [], added = [];
  const service = createExternalStoreService({ userDataDir: '/profile', createDownloads: options => {
    created.push(options.store); return { addGame: async url => { added.push(url); return { connection: { mode: 'public' } }; }, dispose() {} };
  } });
  assert.deepEqual(created, []);
  const result = await service.addGame('itch', 'https://example.itch.io/game');
  assert.equal(result.connection.mode, 'public');
  assert.deepEqual(added, ['https://example.itch.io/game']);
  assert.deepEqual(created, ['itch']);
  assert.throws(() => service.addGame('../itch', 'https://example.itch.io/game'), /Choose/);
  assert.throws(() => service.addGame('gog', 'https://example.itch.io/game'), /itch.io tab/);
  assert.equal(added.length, 1);
  await service.dispose();
});

test('Google Play reuses the account provider, preserves its picker and forwards explicit version profiles', async () => {
  const configs = new Map(), calls = [], updates = [];
  const account = { id: 'macapk:account', label: 'Google account', source: 'Mac.apk', available: true };
  const microgLogin = async options => ({ authToken: 'private-scoped-token', ...options });
  const service = createExternalStoreService({ userDataDir: '/profile', microgLogin,
    listAccounts: async options => { calls.push(['accounts', options]); return { accounts: [account], providers: [] }; },
    openAccounts: async () => { calls.push(['openAccounts']); return true; },
    browserLogin: async () => { calls.push(['browser']); }, onChange: update => updates.push(update),
    createDownloads: options => {
      configs.set(options.store, options);
      return { snapshot: () => ({ connection: {}, downloads: [] }),
        getVersions: async (id, options) => { calls.push(['versions', id, options]); return {}; },
        search: async (query, options) => { calls.push(['search', query, options]); return []; },
        addToLibrary: async (id, options) => { calls.push(['addToLibrary', id, options]); return {}; }, dispose() {} };
    } });
  assert.deepEqual(configs.size, 0);
  service.snapshot('google-play');
  await service.accounts('google-play', false);
  assert.deepEqual(calls[0], ['accounts', { refresh: false }]);
  assert.deepEqual(service.snapshot('google-play').availableAccounts, [account]);
  configs.get('google-play').onChange();
  assert.deepEqual(updates.at(-1).state.availableAccounts, [account]);
  assert.equal(configs.get('google-play').microgLogin, microgLogin);
  await service.versions('google-play', 'org.example.game', true, { architecture: 'x86', language: 'fr-FR', androidSdk: 34 });
  assert.deepEqual(calls.at(-1), ['versions', 'org.example.game', { refresh: true, architecture: 'x86', language: 'fr-FR', androidSdk: 34 }]);
  await service.search('google-play', 'example', { requestId: 'query-1', sources: ['fdroid'] });
  assert.deepEqual(calls.at(-1), ['search', 'example', { requestId: 'query-1', sources: ['fdroid'] }]);
  await service.addToLibrary('google-play', 'org.example.game', { architecture: 'armv7', androidSdk: 34 });
  assert.deepEqual(calls.at(-1), ['addToLibrary', 'org.example.game', { architecture: 'armv7', androidSdk: 34 }]);
  await service.openAccounts('google-play');
  assert.deepEqual(calls.at(-1), ['openAccounts']);
  service.snapshot('gog');
  assert.equal(configs.get('gog').microgLogin, undefined);
  await assert.rejects(service.accounts('gog', true), /unavailable/);
  assert.equal(calls.some(call => call[0] === 'browser'), false);
  await service.dispose();
});
