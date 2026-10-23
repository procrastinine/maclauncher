const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createSteamSessionStorage({ userDataDir, safeStorage, namespace = 'steam' }) {
  const directory = path.join(userDataDir, namespace), file = path.join(directory, 'session.enc');
  let tail = Promise.resolve();
  const key = accountName => String(accountName).trim().toLowerCase();
  async function read(mutating = false) {
    if (!safeStorage?.isEncryptionAvailable()) {
      if (mutating) throw new Error('Saving sign-in requires access to the macOS Keychain.');
      return {};
    }
    try {
      const data = JSON.parse(safeStorage.decryptString(await fs.readFile(file)));
      return data?.refreshToken ? { [key(data.accountName)]: data } : data?.sessions || {};
    } catch (error) {
      if (mutating && error.code !== 'ENOENT') throw new Error('Saved sign-ins could not be read from the macOS Keychain.');
      return {};
    }
  }
  async function write(sessions) {
    if (!Object.keys(sessions).length) { await fs.rm(file, { force: true }); return; }
    if (!safeStorage?.isEncryptionAvailable()) throw new Error('Saving sign-in requires access to the macOS Keychain.');
    const encrypted = safeStorage.encryptString(JSON.stringify({ sessions }));
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.session-${crypto.randomUUID()}`);
    try { await fs.writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  function mutate(change) {
    const operation = tail.then(async () => { const sessions = await read(true); change(sessions); await write(sessions); });
    tail = operation.catch(() => {}); return operation;
  }
  return {
    async loadSession(accountName) { await tail; const sessions = await read(); return (accountName ? sessions[key(accountName)] : Object.values(sessions)[0]) || null; },
    async listAccounts() { await tail; return Object.values(await read()).map(session => ({ accountName: session.accountName })); },
    saveSession(session, accountName) {
      return mutate(sessions => {
        if (session?.accountName) sessions[key(session.accountName)] = session;
        else if (accountName) delete sessions[key(accountName)];
        else for (const name of Object.keys(sessions)) delete sessions[name];
      });
    },
    removeSession(accountName) { return mutate(sessions => { delete sessions[key(accountName)]; }); }
  };
}
module.exports = { createSteamSessionStorage };
