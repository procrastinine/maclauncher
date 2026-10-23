const path = require('node:path');
const crypto = require('node:crypto');

function createSteamWindowService({ userDataDir, homeDir, readGames, importGame, onChange = () => {},
  discover = options => require('../core/external-installed-games').discoverExternalInstalledGames(options),
  discoverDownloads = options => require('../core/external-installed-games').discoverDownloadedGames(options),
  createDownloads = options => require('../core/steam-downloads').createSteamDownloads(options),
  createClientSession = options => require('../core/steam-client-session').createSteamClientSession(options),
  createHistory = options => require('../core/steam-version-history').createSteamVersionHistory(options),
  loadSession, saveSession, listAccounts, removeSession, confirmDuplicate } = {}) {
  let closed = false, scanning, initialized, activeAccountId = null, history;
  const clients = new Map(), imports = new Map(), pending = new Map();
  const defaultDirectory = path.join(userDataDir, 'external', 'downloads', 'steam');
  function snapshot() {
    const active = clients.get(activeAccountId), state = active?.service.snapshot();
    return { ...(state || { connection: { status: 'disconnected' }, library: [], libraryLoading: false, libraryFetchedAt: null }),
      connection: { ...(state?.connection || { status: 'disconnected' }), ...(active ? { mode: active.mode } : {}) },
      accounts: [...clients.values()].map(record => ({ id: record.id, accountName: record.service.snapshot().connection.accountName || record.accountName,
        mode: record.mode, status: record.service.snapshot().connection.status })), activeAccountId,
      downloads: [...clients.values()].flatMap(record => record.service.snapshot().downloads.map(job => ({ ...job,
        accountId: record.id, accountName: record.service.snapshot().connection.accountName || record.accountName,
        mode: record.mode }))).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))),
      imports: [...imports.values()], defaultDirectory };
  }
  const changed = () => { if (!closed) onChange(snapshot()); };
  function findDownload(id) {
    for (const record of clients.values()) {
      const job = record.service.snapshot().downloads.find(item => item.id === id);
      if (job) return { record, job };
    }
    return null;
  }
  function queueImport({ id, name, gamePath, downloadId }) {
    if (closed) throw new Error('External window is closing.');
    if (pending.has(gamePath)) return pending.get(gamePath);
    const job = { id: crypto.randomUUID(), sourceId: id, name, status: 'queued', path: gamePath };
    if (imports.size >= 100) for (const [key, value] of imports) {
      if (!['queued', 'importing'].includes(value.status)) { imports.delete(key); break; }
    }
    imports.set(job.id, job);
    const task = Promise.resolve().then(async () => {
      job.status = 'importing'; changed();
      const result = await importGame(gamePath, { background: true });
      if (downloadId) findDownload(downloadId)?.record.service.markImported?.(downloadId);
      job.status = 'completed'; return result;
    }).catch(error => { job.status = 'error'; job.error = String(error?.message || error); throw error; })
      .finally(() => { pending.delete(gamePath); changed(); });
    pending.set(gamePath, task); task.catch(() => {}); changed(); return task;
  }
  function makeAccount(mode, accountName = '') {
    if (closed) throw new Error('External window is closing.');
    const id = mode === 'client' ? 'desktop' : `manual-${crypto.createHash('sha256').update(accountName.toLowerCase()).digest('hex').slice(0, 24)}`;
    if (clients.has(id)) return clients.get(id);
    const config = { userDataDir, homeDir, accountName, onChange: changed, confirmDuplicate,
      loadSession: () => loadSession?.(accountName),
      saveSession: session => saveSession?.(session, accountName),
      onDownloaded: job => queueImport({ id: job.id, name: job.name, gamePath: job.path, downloadId: job.id }) };
    const record = { id, mode, accountName, service: mode === 'client' ? createClientSession(config) : createDownloads(config) };
    clients.set(id, record); activeAccountId ||= id; return record;
  }
  function active() {
    const record = clients.get(activeAccountId); if (!record) throw new Error('Choose a Steam account.'); return record.service;
  }
  async function initialize() {
    if (!initialized) initialized = (async () => {
      makeAccount('client');
      for (const account of await listAccounts?.() || []) if (account?.accountName) makeAccount('manual', account.accountName);
      return snapshot();
    })().catch(error => { initialized = null; throw error; });
    await initialized; return snapshot();
  }
  async function connect(credentials = {}) {
    const mode = credentials.mode === 'client' ? 'client' : 'manual';
    let accountName = String(credentials.accountName || '').trim();
    if (mode === 'manual' && !accountName) accountName = (await loadSession?.())?.accountName || '';
    if (mode === 'manual' && (!accountName || accountName.length > 128 || /[\x00-\x1f]/.test(accountName))) throw new Error('Enter a Steam account name.');
    const record = makeAccount(mode, accountName); activeAccountId = record.id; changed();
    const result = await record.service.connect({ ...credentials, accountName }); changed(); return result;
  }
  async function selectAccount(id) {
    const record = clients.get(id); if (!record) throw new Error('Steam account was not found.');
    activeAccountId = id; changed();
    const status = record.service.snapshot().connection.status;
    if (!['connected', 'connecting', 'guard'].includes(status)) {
      if (record.mode === 'client' || (await loadSession?.(record.accountName))?.refreshToken)
        await record.service.connect({ accountName: record.accountName, remember: true });
    }
    changed(); return snapshot();
  }
  async function removeAccount(id) {
    const record = clients.get(id); if (!record || record.mode !== 'manual') throw new Error('Only manual sign-ins can be removed.');
    if (record.service.snapshot().downloads.some(job => ['queued', 'preparing', 'downloading'].includes(job.status)))
      throw new Error('Cancel this account’s downloads before removing it.');
    await record.service.dispose(); await removeSession?.(record.accountName);
    clients.delete(id); if (activeAccountId === id) activeAccountId = clients.has('desktop') ? 'desktop' : clients.keys().next().value || null;
    changed(); return snapshot();
  }
  async function scan() {
    if (scanning) return scanning;
    scanning = Promise.resolve().then(() => discover({ homeDir, userDataDir, games: readGames() })).finally(() => { scanning = null; }); return scanning;
  }
  async function importInstalled(ids) {
    if (!Array.isArray(ids) || ids.length > 10000 || ids.some(id => typeof id !== 'string')) throw new Error('Choose installed games to import.');
    const selected = new Set(ids), queued = [];
    for (const row of await scan()) if (selected.has(row.id) && !row.imported) {
      queueImport({ id: row.id, name: row.name, gamePath: row.gamePath || row.path }); queued.push(row.id);
    }
    return { queued };
  }
  async function listDownloaded() { return discoverDownloads({ homeDir, userDataDir, games: readGames() }); }
  async function importCopies(ids) {
    if (!Array.isArray(ids) || ids.length > 10000 || ids.some(id => typeof id !== 'string')) throw new Error('Choose downloaded copies to import.');
    const selected = new Set(ids), queued = [];
    for (const row of await listDownloaded()) if (selected.has(row.id) && !row.imported) {
      queueImport({ id: row.id, name: row.name, gamePath: row.importPath || row.gamePath || row.path }); queued.push(row.id);
    }
    return { queued };
  }
  function importDownload(id) {
    if (typeof id !== 'string') throw new Error('Choose a completed download.');
    const found = findDownload(id), job = found?.job;
    if (!job || job.status !== 'completed' || !job.path) throw new Error('Wait for the download to finish.');
    if (job.imported) return { queued: [] };
    queueImport({ id: job.id, name: job.name, gamePath: job.path, downloadId: id }); return { queued: [id] };
  }
  async function previousVersions(appId, depotIds, refresh) {
    if (closed) throw new Error('External window is closing.');
    if (!Array.isArray(depotIds) || !depotIds.length || depotIds.length > 32) throw new Error('Choose up to 32 depots to fetch previous versions.');
    const versions = await active().getVersions(appId);
    const allowed = new Set(versions.depots.map(depot => String(depot.id)));
    if (depotIds.some(id => !allowed.has(String(id)))) throw new Error('Choose depots listed for this game.');
    history ||= createHistory({ userDataDir });
    return history.get(appId, depotIds, { refresh: refresh === true });
  }
  return { snapshot, initialize, scan, importInstalled, importDownload, listDownloaded, importCopies, connect, selectAccount, removeAccount,
    previousVersions,
    importExternal: job => queueImport({ id: job.id, name: job.name, gamePath: job.importPath || job.path }),
    submitAuth: response => active().submitAuth(response),
    loadLibrary: refresh => active().loadLibrary({ refresh: refresh === true }),
    getVersions: (appId, refresh) => active().getVersions(appId, { refresh: refresh === true }),
    download: selection => active().download(selection),
    cancel: id => findDownload(id)?.record.service.cancel(id),
    disconnect: () => clients.get(activeAccountId)?.service.disconnect(),
    async dispose() { closed = true; history?.dispose(); await Promise.allSettled([...clients.values()].map(record => record.service.dispose())); await Promise.allSettled([...pending.values()]); }
  };
}
module.exports = { createSteamWindowService };
