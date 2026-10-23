function createExternalStoreService({ userDataDir, homeDir, createDownloads = options => require('../core/external-store-providers').createExternalStoreDownloads(options),
  createStorage = () => ({}), importGame, openExternal, browserLogin, focusLogin, clearBrowserAccount, microgLogin,
  listAccounts, openAccounts, prepareAccountSession, confirmDuplicate, onChange = () => {} } = {}) {
  const clients = new Map(), storages = new Map();
  let accountListing = { accounts: [], providers: [] };
  const decorate = (store, state) => store === 'google-play' ? { ...state, availableAccounts: accountListing.accounts } : state;
  function validate(store) { if (!require('../core/external-store-providers').storeIds.includes(store)) throw new Error('Choose an external game store.'); return store; }
  function get(store) {
    validate(store);
    if (!clients.has(store)) {
      const storage = createStorage(store); storages.set(store, storage);
      clients.set(store, createDownloads({ store, userDataDir, homeDir, confirmDuplicate,
        ...(store === 'google-play' ? { browserLogin, clearBrowserAccount, microgLogin } : {}),
        ...storage, onChange: () => {
          const state = clients.get(store)?.snapshot();
          if (state) onChange({ store, state: decorate(store, state) });
        },
        onDownloaded: job => importGame(job) }));
    }
    return clients.get(store);
  }
  return {
    snapshot: store => decorate(store, get(store).snapshot()),
    connect: async (store, credentials) => {
      validate(store);
      if (store === 'google-play' && credentials?.mode === 'reuse') await prepareAccountSession?.();
      return get(store).connect(credentials);
    },
    auth: (store, response) => get(store).submitAuth(response),
    library: (store, refresh) => get(store).loadLibrary({ refresh: refresh === true }),
    search: (store, query, options) => {
      const service = get(store);
      if (typeof service.search !== 'function') throw new Error('Search the loaded store library instead.');
      return service.search(query, options);
    },
    addGame: (store, url) => {
      validate(store);
      if (store !== 'itch') throw new Error('Public game links are supported in the itch.io tab.');
      const service = get(store);
      if (typeof service.addGame !== 'function') throw new Error('Public game links are unavailable. Reopen External to try again.');
      return service.addGame(url);
    },
    versions: (store, id, refresh, options = {}) => get(store).getVersions(id, {
      refresh: refresh === true, architecture: options?.architecture, language: options?.language, androidSdk: options?.androidSdk
    }),
    addToLibrary: (store, id, options) => {
      const service = get(store);
      if (typeof service.addToLibrary !== 'function') throw new Error('Adding apps to the account library is unavailable for this store.');
      return service.addToLibrary(id, options);
    },
    accounts: async (store, refresh) => {
      if (validate(store) !== 'google-play' || typeof listAccounts !== 'function') throw new Error('Account management is unavailable for this store.');
      accountListing = await listAccounts({ refresh: refresh === true });
      if (clients.has(store)) onChange({ store, state: decorate(store, clients.get(store).snapshot()) });
      return accountListing;
    },
    openAccounts: store => {
      if (validate(store) !== 'google-play' || typeof openAccounts !== 'function') throw new Error('Account management is unavailable for this store.');
      return openAccounts();
    },
    accountRemoved: async (store, account) => {
      validate(store);
      const service = clients.get(store), connection = service?.snapshot().connection;
      if (connection && (connection.accountId === account.id || connection.mode === 'browser' && account.provider === 'klepton' &&
          connection.accountName?.toLowerCase() === account.label?.toLowerCase())) await service.disconnect();
      return true;
    },
    download: (store, selection) => get(store).download(selection),
    cancel: (store, id) => get(store).cancel(id),
    disconnect: store => get(store).disconnect(),
    async forget(store) {
      const service = get(store);
      if (service.forgetSession) await service.forgetSession();
      else await service.disconnect();
      await storages.get(store)?.saveSession?.(null);
      return service.snapshot();
    },
    async openLogin(store) {
      if (validate(store) === 'google-play') {
        if (focusLogin?.()) return true;
        const service = get(store);
        return typeof service.openLogin === 'function' ? service.openLogin() : service.connect({ mode: 'browser', remember: true });
      }
      const state = get(store).snapshot(), url = store === 'itch' ? 'https://itch.io/user/settings/api-keys' : state.connection.authUrl || state.connection.guard?.url;
      let parsed; try { parsed = new URL(url); } catch { throw new Error('Start store sign-in before opening its login page.'); }
      const allowed = store === 'epic' ? ['epicgames.com', 'legendary.gl'] : store === 'itch' ? ['itch.io'] : ['gog.com'];
      if (parsed.protocol !== 'https:' || !allowed.some(host => parsed.hostname === host || parsed.hostname.endsWith('.' + host)))
        throw new Error('The store sign-in address is invalid.');
      await openExternal(parsed.href); return true;
    },
    async importDownload(store, id) {
      const service = get(store), job = service.snapshot().downloads.find(item => item.id === id);
      if (!job || job.status !== 'completed' || !job.path) throw new Error('Wait for the download to finish.');
      if (job.imported) return { queued: [] };
      void Promise.resolve().then(() => importGame(job)).then(() => service.markImported(id)).catch(() => {});
      return { queued: [id] };
    },
    hasActive: () => [...clients.values()].some(service => service.snapshot().downloads.some(job => ['queued', 'preparing', 'downloading'].includes(job.status))),
    async dispose() { await Promise.allSettled([...clients.values()].map(service => service.dispose())); }
  };
}
module.exports = { createExternalStoreService };
