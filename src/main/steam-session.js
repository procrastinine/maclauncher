const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createSteamSessionStorage({ userDataDir, safeStorage, namespace = 'steam', cacheDecrypted = false }) {
  const directory = path.join(userDataDir, namespace), file = path.join(directory, 'session.enc');
  const accountIndex = path.join(directory, 'accounts.json');
  let tail = Promise.resolve();
  let cachedSessions, reading, availability;
  const key = accountName => String(accountName).trim().toLowerCase();
  function encryptionAvailable() {
    if (!cacheDecrypted) return safeStorage?.isAsyncEncryptionAvailable();
    return availability ||= Promise.resolve().then(() => safeStorage?.isAsyncEncryptionAvailable()).then(value => {
      if (!value) availability = null;
      return value;
    }, error => { availability = null; throw error; });
  }
  async function writePrivate(destination, bytes) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.session-${crypto.randomUUID()}`);
    try { await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, destination); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async function index(sessions) {
    // Account labels can be displayed without opening the credential vault.
    await writePrivate(accountIndex, JSON.stringify(Object.values(sessions).map(session => ({ accountName: session.accountName,
      ...(typeof session.session?.email === 'string' ? { label: session.session.email } : {}) }))));
  }
  async function read(mutating = false) {
    try {
      if (cacheDecrypted && cachedSessions) return cachedSessions;
      const load = async () => {
        let encrypted;
        try { encrypted = await fs.readFile(file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
        if (!await encryptionAvailable()) throw new Error('Saving sign-in requires access to the macOS Keychain.');
        const { result } = await safeStorage.decryptStringAsync(encrypted);
        const data = JSON.parse(result);
        const sessions = data?.refreshToken ? { [key(data.accountName)]: data } : data?.sessions;
        if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) throw new Error('Invalid saved sign-ins.');
        await index(sessions).catch(() => {});
        return sessions;
      };
      if (!cacheDecrypted) return await load();
      reading ||= load().then(value => { cachedSessions = value; return value; }).finally(() => { reading = null; });
      return await reading;
    } catch (error) {
      if (mutating && error.code !== 'ENOENT') throw Object.assign(new Error('Saved sign-ins could not be read from the macOS Keychain.', { cause: error }), { code: 'SESSION_UNLOCK_FAILED' });
      return {};
    }
  }
  async function write(sessions) {
    if (cacheDecrypted && Object.keys(sessions).length && cachedSessions && JSON.stringify(sessions) === JSON.stringify(cachedSessions)) return;
    if (!Object.keys(sessions).length) {
      await fs.rm(file, { force: true }); await fs.rm(accountIndex, { force: true });
      if (cacheDecrypted) cachedSessions = {};
      return;
    }
    if (!await encryptionAvailable()) throw new Error('Saving sign-in requires access to the macOS Keychain.');
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify({ sessions }));
    await writePrivate(file, encrypted);
    if (cacheDecrypted) cachedSessions = sessions;
    await index(sessions);
  }
  function mutate(change) {
    const operation = tail.then(async () => { const sessions = structuredClone(await read(true)); await change(sessions); await write(sessions); });
    tail = operation.catch(() => {}); return operation;
  }
  return {
    async loadSession(accountName) { await tail; const sessions = await read(cacheDecrypted); return structuredClone((accountName ? sessions[key(accountName)] : Object.values(sessions)[0]) || null); },
    async listAccounts() {
      await tail;
      try {
        const accounts = JSON.parse(await fs.readFile(accountIndex, 'utf8'));
        return Array.isArray(accounts) ? accounts.filter(account => typeof account?.accountName === 'string').map(({ accountName, label }) => ({ accountName,
          ...(typeof label === 'string' ? { label } : {}) })) : [];
      } catch { return []; }
    },
    saveSession(session, accountName) {
      return mutate(sessions => {
        if (session?.accountName) sessions[key(session.accountName)] = session;
        else if (accountName) delete sessions[key(accountName)];
        else for (const name of Object.keys(sessions)) delete sessions[name];
      });
    },
    removeSession(accountName) { return mutate(sessions => { delete sessions[key(accountName)]; }); },
    updateSessions: mutate
  };
}
module.exports = { createSteamSessionStorage };
