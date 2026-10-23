const crypto = require("node:crypto");
const { createGooglePlayDownloads } = require("./downloads");
const { createRepositoryDownloads, parseSourceQuery, SOURCES } = require("./repositories");
const clone = value => JSON.parse(JSON.stringify(value));

function createAndroidStoreDownloads(options = {}) {
  let google, disposed = false, searchController, searchGeneration = 0;
  const repositories = new Map(), state = { search: null };
  const emit = () => { if (!disposed) options.onChange?.(snapshot()); };
  google = (options.createGooglePlayDownloads || createGooglePlayDownloads)({ ...options, onChange: emit });
  for (const source of Object.keys(SOURCES)) repositories.set(source, (options.createRepositoryDownloads || createRepositoryDownloads)({ ...options, ...(options.repositories?.[source] || {}), source, onChange: emit }));
  function snapshot() { const base = google.snapshot(); return { ...base, search: state.search ? clone(state.search) : null, downloads: [...(base.downloads || []), ...[...repositories.values()].flatMap(repository => repository.snapshot().downloads)].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) }; }
  function provider(value) { const source = /^(fdroid|izzy):/i.exec(String(value || ""))?.[1]?.toLowerCase(); return source ? repositories.get(source) : google; }
  async function search(query, opts = {}) {
    searchController?.abort(); const current = ++searchGeneration, controller = searchController = new AbortController(), signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal, parsed = parseSourceQuery(query);
    const requestedSources = Array.isArray(opts.sources) ? ["google-play", "fdroid", "izzy"].filter(source => opts.sources.includes(source)) : ["google-play", "fdroid", "izzy"];
    const requestId = opts.requestId || crypto.randomUUID(), sourceIds = parsed.source ? [parsed.source] : requestedSources;
    state.search = { requestId, query: String(query), results: [], sources: ["google-play", "fdroid", "izzy"].map(id => ({ id, label: id === "google-play" ? "Google Play" : SOURCES[id].label, status: sourceIds.includes(id) ? id === "google-play" && google.snapshot().connection?.status !== "connected" ? "skipped" : "loading" : "skipped" })), loading: true }; emit();
    await Promise.all(sourceIds.map(async source => {
      if (state.search.sources.find(value => value.id === source).status === "skipped") return;
      try {
        const rows = await (source === "google-play" ? google : repositories.get(source)).search(parsed.packageName ? source === "google-play" ? parsed.packageName : `${source}:${parsed.packageName}` : parsed.query, { ...opts, signal });
        if (current !== searchGeneration || signal.aborted) return;
        state.search.results.push(...rows.map(row => ({ ...row, packageName: row.packageName || row.appId, source, sourceLabel: source === "google-play" ? "Google Play" : SOURCES[source].label })));
        state.search.sources.find(value => value.id === source).status = "completed";
      } catch (error) {
        if (current !== searchGeneration || signal.aborted) return;
        const status = state.search.sources.find(value => value.id === source); status.status = "error"; status.error = error.playPublic || error.googlePlayPublic ? error.message : "This Android source could not complete the search.";
      }
      if (current === searchGeneration) { state.search.loading = state.search.sources.some(value => value.status === "loading"); emit(); }
    }));
    if (current !== searchGeneration || signal.aborted) return [];
    state.search.loading = false; emit(); return clone(state.search.results);
  }
  async function dispose() { disposed = true; searchGeneration++; searchController?.abort(); await Promise.all([google.dispose(), ...[...repositories.values()].map(value => value.dispose())]); }
  return { snapshot, search, dispose,
    connect: (...args) => google.connect(...args), disconnect: (...args) => google.disconnect(...args), forgetSession: (...args) => google.forgetSession(...args), openLogin: (...args) => google.openLogin(...args), submitAuth: (...args) => google.submitAuth(...args), loadLibrary: (...args) => google.loadLibrary(...args), addToLibrary: (...args) => google.addToLibrary(...args),
    getVersions: (appId, opts) => provider(appId).getVersions(appId, opts), download: selection => provider(selection.appId).download(selection),
    cancel(id) { google.cancel(id); for (const value of repositories.values()) value.cancel(id); return snapshot(); },
    markImported(id) { google.markImported(id); for (const value of repositories.values()) value.markImported(id); return snapshot(); } };
}
module.exports = { createAndroidStoreDownloads };
