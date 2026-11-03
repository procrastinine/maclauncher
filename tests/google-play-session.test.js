const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createSteamSessionStorage } = require('../src/main/steam-session');
const { createGoogleAccountManager } = require('../src/modules/android/store/google-account-manager');
const { createGooglePlayDownloads } = require('../src/modules/android/store/downloads');
const email = 'saved@example.invalid', token = 'private-fixture-master-token', scopedToken = 'private-fixture-scoped-token';
const encode = text => Buffer.from(text.split('').reverse().join(''));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'google-vault-session-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const access = { approved: false, dismissed: false, prompts: 0 };
  function open() {
    const calls = { initialize: 0, encrypt: 0, decrypt: 0 };
    const safeStorage = {
      async isAsyncEncryptionAvailable() {
        calls.initialize++;
        if (access.dismissed) return false;
        if (!access.approved) { access.prompts++; access.approved = true; }
        return true;
      },
      async encryptStringAsync(text) { calls.encrypt++; assert.equal(access.approved, true); return encode(text); },
      async decryptStringAsync(bytes) { calls.decrypt++; assert.equal(access.approved, true); return { result: bytes.toString().split('').reverse().join(''), shouldReEncrypt: false }; }
    };
    const vault = createSteamSessionStorage({ userDataDir: root, namespace: 'external/google-play', safeStorage, cacheDecrypted: true });
    const manager = createGoogleAccountManager({ vault,
      browserAuth: { signIn: async () => ({ email, aasToken: token }) },
      microg: { importBrowserSession() { assert.fail('External browser sign-in must not start an Android runtime'); } }
    });
    return { vault, manager, calls };
  }
  return { root, open, access, file: path.join(root, 'external/google-play/session.enc') };
}
function service(f, owner, onChange) {
  return createGooglePlayDownloads({ userDataDir: f.root,
    onChange,
    browserLogin: options => owner.manager.browserLogin(options),
    loadSession: () => owner.manager.loadActiveSession(),
    saveSession: value => owner.manager.saveActiveSession(value),
    loadSessionMetadata: async () => (await owner.vault.listAccounts()).find(row => row.accountName === 'google-play'),
    protocol: {
      async prepareDevice({ architecture, locale, androidSdk }) { return { androidId: '1234', device: { architecture, locale, sdk: androidSdk } }; },
      async authorize(session, registration) { assert.equal(session.aasToken, token); return { ...registration, authToken: scopedToken, expiresAt: Date.now() + 3600000 }; },
      async library() { return { library: [], truncated: false }; }
    }
  });
}

test('External sign-in initializes Keychain once, persists encrypted credentials and reuses them after restart', async t => {
  const f = await fixture(t), first = f.open(), downloads = service(f, first);
  t.after(() => downloads.dispose());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(first.calls, { initialize: 0, encrypt: 0, decrypt: 0 });
  await downloads.connect({ mode: 'browser', remember: true });
  assert.equal(first.calls.initialize, 1, 'One OS encryptor initialization for the whole sign-in');
  assert.equal(f.access.prompts, 1);
  assert.equal(first.calls.decrypt, 0, 'Fresh sign-in does not repeatedly reopen its own ciphertext');
  assert.equal(first.calls.encrypt, 2, 'Browser authorization is saved before Play setup, then updated once with device authorization');
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  assert.equal((await fs.readFile(f.file)).includes(Buffer.from(token)), false);
  await downloads.dispose();
  const restarted = f.open();
  restarted.manager.browserLogin = () => assert.fail('Saved-session reuse must not open Google sign-in');
  let metadataLoaded;
  const ready = new Promise(resolve => { metadataLoaded = resolve; });
  const resumed = service(f, restarted, snapshot => { if (snapshot.hasSavedSession) metadataLoaded(); });
  t.after(() => resumed.dispose());
  await ready;
  assert.equal(resumed.snapshot().hasSavedSession, true);
  assert.equal(resumed.snapshot().connection.accountName, email);
  assert.deepEqual(restarted.calls, { initialize: 0, encrypt: 0, decrypt: 0 }, 'Labels are read only from the account index');
  await resumed.connect({ mode: 'reuse' });
  assert.equal(resumed.snapshot().connection.status, 'connected');
  assert.deepEqual(restarted.calls, { initialize: 1, encrypt: 0, decrypt: 1 });
  assert.equal(f.access.prompts, 1, 'Approved access survives a new vault/manager instance');
  assert.equal((await restarted.manager.loadActiveSession()).aasToken, token);
  assert.equal(restarted.calls.decrypt, 1, 'The opened vault stays cached for this process');
});

test('a dismissed Keychain prompt preserves ciphertext, index and saved account through reuse and a failed new sign-in', async t => {
  const f = await fixture(t), initial = f.open();
  await initial.manager.browserLogin();
  const original = await fs.readFile(f.file), index = await fs.readFile(path.join(path.dirname(f.file), 'accounts.json'));
  f.access.dismissed = true;
  const locked = f.open(), downloads = service(f, locked); t.after(() => downloads.dispose());
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(downloads.connect({ mode: 'reuse' }), /saved session has been kept/);
  assert.equal(downloads.snapshot().hasSavedSession, true);
  assert.equal(downloads.snapshot().connection.accountName, email);
  await assert.rejects(locked.manager.browserLogin(), /Saved sign-ins could not be read/);
  assert.deepEqual(await fs.readFile(f.file), original);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(f.file), 'accounts.json')), index);
  f.access.dismissed = false;
  await downloads.connect({ mode: 'reuse' });
  assert.equal(downloads.snapshot().connection.status, 'connected');
});

test('legacy encrypted JSON opens without migration and a failed encrypt keeps both cached and disk sessions intact', async t => {
  const f = await fixture(t), directory = path.dirname(f.file);
  await fs.mkdir(directory, { recursive: true });
  const original = encode(JSON.stringify({ sessions: { 'google-play': { accountName: 'google-play', session: { email, aasToken: token } } } }));
  await fs.writeFile(f.file, original, { mode: 0o600 });
  const owner = f.open();
  assert.equal((await owner.manager.loadActiveSession()).aasToken, token);
  assert.deepEqual(await fs.readFile(f.file), original);
  const copy = await owner.manager.loadActiveSession(); copy.aasToken = 'changed-only-by-caller';
  assert.equal((await owner.manager.loadActiveSession()).aasToken, token, 'Callers cannot silently mutate the cached vault');
  const broken = createSteamSessionStorage({ userDataDir: f.root, namespace: 'external/google-play', cacheDecrypted: true,
    safeStorage: { isAsyncEncryptionAvailable: async () => true,
      decryptStringAsync: async bytes => ({ result: bytes.toString().split('').reverse().join('') }),
      encryptStringAsync: async () => { throw Error('Encryption cancelled'); } } });
  await assert.rejects(broken.saveSession({ accountName: 'other', session: { email: 'other@example.invalid' } }), /Encryption cancelled/);
  assert.deepEqual(await fs.readFile(f.file), original);
  assert.equal(await broken.loadSession('other'), null);
  assert.equal((await broken.loadSession('google-play')).session.aasToken, token);
});
