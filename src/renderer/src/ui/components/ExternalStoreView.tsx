import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DownloadIcon, RefreshIcon } from "../icons";
import { LibrarySearch } from "./LibraryToolbar";
import { HelpTip } from "./HelpTip";
import { formatUserError } from "../ui-helpers";
import type { SteamDownload, SteamLibraryGame, SteamPlatform, SteamVersions } from "./SteamView";

export type ExternalStore = "epic" | "gog" | "itch" | "google-play";
export type ExternalPlatform = SteamPlatform | "web" | "android";
export type AndroidStoreSource = "google-play" | "fdroid" | "izzy";
export type ExternalDownloadStore = ExternalStore | "steam" | "fdroid" | "izzy";
export type ExternalSearchState = { requestId: string; query: string; results: ExternalLibraryGame[]; sources: Array<{ id: AndroidStoreSource; label: string; status: "loading" | "completed" | "error" | "skipped"; error?: string }>; loading: boolean };
export type ExternalVersionBranch = {
  id: string; name: string; description?: string; buildId?: string; updatedAt?: string | number | null;
  platforms?: ExternalPlatform[]; platform?: ExternalPlatform; versionCode?: string; versionName?: string; architectures?: string[]; minSdk?: number; maxSdk?: number; targetSdk?: number; abiIndependent?: boolean;
};
export type ExternalLibraryGame = Omit<SteamLibraryGame, "platforms"> & { platforms: ExternalPlatform[]; owned?: boolean; versionCode?: string; versionName?: string; developer?: string; priceMicros?: string | null; checkoutRequired?: boolean; canAddToLibrary?: boolean; source?: AndroidStoreSource; sourceLabel?: string; packageName?: string };
export type ExternalDownload = Omit<SteamDownload, "platform"> & { platform: ExternalPlatform };
export type ExternalStoreVersions = Omit<SteamVersions, "platforms" | "branches" | "architectures"> & {
  platforms: ExternalPlatform[]; branches: ExternalVersionBranch[]; languages?: string[]; supportsManifestOverride?: boolean; supportsVersionCode?: boolean;
  architectures?: string[] | Partial<Record<ExternalPlatform, string[]>>;
  source?: AndroidStoreSource; sourceLabel?: string; defaultDirectory?: string; packageName?: string;
  app?: ExternalLibraryGame; available?: boolean; unavailableReason?: string;
  profile?: { architecture: string; androidSdk?: number; sdk?: number }; sdkVersions?: number[];
  deviceProfiles?: Array<{ architecture: string; androidSdk?: number; sdk?: number; label: string; available: boolean | null; reason?: string }>;
};
export type ExternalLibrarySort = "name-asc" | "name-desc" | "platform" | "access" | "version" | "store" | "path" | "imported";
export type ExternalSharedAccount = { id: string; label: string; source?: string; available?: boolean; provider?: string };
export type ExternalAccountListing = { accounts: ExternalSharedAccount[]; providers?: Array<{ id?: string; label?: string; source?: string; available?: boolean; message?: string }> };
export type ExternalStoreSnapshot = {
  connection: { status: "disconnected" | "connecting" | "guard" | "connected" | "error"; accountName?: string; displayName?: string; mode?: "reuse" | "manual" | "public" | "browser" | "microg";
    phase?: "browser" | "authorizing"; error?: string; authUrl?: string; guard?: { kind: "authorization"; url?: string; message?: string } };
  library: ExternalLibraryGame[]; libraryLoading: boolean; libraryError?: string | null; downloads: ExternalDownload[];
  defaultDirectory?: string; cancellationNotice?: string; hasSavedKey?: boolean; hasSavedSession?: boolean; libraryNote?: string;
  capabilities?: { search?: boolean; ownedLibrary?: boolean };
  availableAccounts?: ExternalSharedAccount[]; search?: ExternalSearchState;
};
export type ExternalStoreSelection = {
  appId: string; name: string; platform: ExternalPlatform; branch: string; language: string; architecture: string;
  autoImport: boolean; destination?: string; manifestUrl?: string;
  versionCode?: string; includeExtras?: boolean;
  androidSdk?: number;
};
export type ExternalStoreApi = {
  externalState: (store: ExternalStore) => Promise<ExternalStoreSnapshot>;
  externalConnect: (store: ExternalStore, credentials: { mode: "reuse" | "manual" | "public" | "browser" | "microg"; code?: string; apiKey?: string; remember?: boolean; accountId?: string }) => Promise<unknown>;
  externalAddGame: (store: "itch", url: string) => Promise<ExternalStoreSnapshot>;
  externalSearch: (store: ExternalStore, query: string, options?: { requestId?: string; architecture?: string; language?: string; androidSdk?: number; sources?: AndroidStoreSource[] }) => Promise<ExternalLibraryGame[]>;
  externalAddToLibrary: (store: "google-play", appId: string, options?: { architecture?: string; language?: string; androidSdk?: number }) => Promise<ExternalStoreSnapshot>;
  externalAccounts: (store: "google-play", refresh: boolean) => Promise<ExternalAccountListing>;
  externalOpenAccounts: (store: "google-play") => Promise<unknown>;
  externalDisconnect: (store: ExternalStore) => Promise<unknown>;
  externalForget: (store: ExternalStore) => Promise<unknown>;
  externalAuth: (store: ExternalStore, credentials: { code: string }) => Promise<unknown>;
  externalOpenLogin: (store: ExternalStore) => Promise<unknown>;
  externalLibrary: (store: ExternalStore, refresh: boolean) => Promise<unknown>;
  externalVersions: (store: ExternalStore, appId: string, refresh: boolean, options?: { architecture?: string; language?: string; androidSdk?: number }) => Promise<ExternalStoreVersions>;
  externalDownload: (store: ExternalStore, selection: ExternalStoreSelection) => Promise<unknown>;
  externalCancel: (store: ExternalStore, id: string) => Promise<unknown>;
  externalImportDownload: (store: ExternalStore, id: string) => Promise<unknown>;
  externalOpenDownloads: (store?: ExternalDownloadStore) => Promise<unknown>;
  onExternalState: (callback: (event: { store: ExternalStore; state: ExternalStoreSnapshot }) => void) => () => void;
};
const labels = { epic: "Epic", gog: "GOG", itch: "itch.io", "google-play": "Google Play" };
const androidSources: Array<{ id: AndroidStoreSource; label: string }> = [{ id: "google-play", label: "Google Play" }, { id: "fdroid", label: "F-Droid" }, { id: "izzy", label: "IzzyOnDroid" }];
const androidSource = (game: ExternalLibraryGame): AndroidStoreSource => game.source || (game.appId.startsWith("fdroid:") ? "fdroid" : game.appId.startsWith("izzy:") ? "izzy" : "google-play");
const androidSourceLabel = (game: ExternalLibraryGame) => game.sourceLabel || androidSources.find(item => item.id === androidSource(game))?.label || "Google Play";
const platformNames: Record<ExternalPlatform, string> = { macos: "Mac", windows: "Windows", linux: "Linux", web: "Web", android: "Android" };
const emptyState: ExternalStoreSnapshot = { connection: { status: "disconnected" }, library: [], libraryLoading: false, downloads: [] };
const message = formatUserError;
const active = (status: string) => ["queued", "preparing", "downloading"].includes(status);

// With counts, only platforms present in the list are offered, each with its count.
export function PlatformTagFilter({ selected, onChange, includeWeb = false, includeAndroid = false, androidOnly = false, label = "Filter platforms", counts }: {
  selected: ReadonlySet<ExternalPlatform>; onChange: (value: Set<ExternalPlatform>) => void; includeWeb?: boolean; includeAndroid?: boolean; androidOnly?: boolean; label?: string;
  counts?: Partial<Record<ExternalPlatform, number>>;
}) {
  const choices = (androidOnly ? ["android"] as ExternalPlatform[] : ["macos", "windows", "linux", ...(includeWeb ? ["web" as const] : []), ...(includeAndroid ? ["android" as const] : [])] as ExternalPlatform[])
    .filter(platform => !counts || (counts[platform] || 0) > 0);
  if (!choices.length) return null;
  return <fieldset className="externalPlatformFilters" aria-label={label}><legend className="externalVisuallyHidden">{label}</legend>
    {choices.map(platform => <label key={platform} className={`externalPlatformFilter ${selected.has(platform) ? "checked" : ""}`}>
      <input type="checkbox" checked={selected.has(platform)} aria-label={`${label}: ${platformNames[platform]}`} onChange={event => {
        const next = new Set(selected); if (event.target.checked) next.add(platform); else next.delete(platform); onChange(next);
      }} /><span>{platformNames[platform]}</span>{counts && <span className="externalPlatformCount">{counts[platform]}</span>}
    </label>)}
  </fieldset>;
}
export function TagCheckboxFilter({ label, options, selected, onChange }: {
  label: string; options: Array<{ id: string; label: string }>; selected: ReadonlySet<string>; onChange: (value: Set<string>) => void;
}) {
  return <fieldset className="externalPlatformFilters" aria-label={label}><legend>{label}</legend>{options.map(option => <label className={`externalPlatformFilter ${selected.has(option.id) ? "checked" : ""}`} key={option.id}>
    <input type="checkbox" aria-label={`${label}: ${option.label}`} checked={selected.has(option.id)} onChange={event => {
      const next = new Set(selected); if (event.target.checked) next.add(option.id); else next.delete(option.id); onChange(next);
    }} /><span>{option.label}</span>
  </label>)}</fieldset>;
}
export function LibrarySortSelect({ value, onChange, label, access = false, version = false, local = false }: {
  value: ExternalLibrarySort; onChange: (value: ExternalLibrarySort) => void; label: string; access?: boolean; version?: boolean; local?: boolean;
}) {
  return <select className="input externalSortSelect" aria-label={label} value={value} onChange={event => onChange(event.target.value as ExternalLibrarySort)}>
    <option value="name-asc">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="platform">Platform</option>
    {access && <option value="access">Access</option>}{version && <option value="version">Version</option>}
    {local && <><option value="store">Store</option><option value="path">Location</option><option value="imported">Import status</option></>}
  </select>;
}
export function sortExternalGames<T extends { name: string; platform?: string; platforms?: string[]; shared?: boolean; owned?: boolean; versionName?: string; version?: string; buildId?: string; store?: string; path?: string; imported?: boolean }>(games: T[], sort: ExternalLibrarySort): T[] {
  const compare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  return [...games].sort((a, b) => {
    if (sort === "platform") { const order = compare(a.platform || a.platforms?.join(",") || "", b.platform || b.platforms?.join(",") || ""); if (order) return order; }
    if (sort === "access") { const order = Number(a.owned === undefined ? Boolean(a.shared) : !a.owned) - Number(b.owned === undefined ? Boolean(b.shared) : !b.owned); if (order) return order; }
    if (sort === "version") { const order = compare(b.versionName || b.version || b.buildId || "", a.versionName || a.version || a.buildId || ""); if (order) return order; }
    if (sort === "store" || sort === "path") { const order = compare(a[sort] || (sort === "store" ? "steam" : ""), b[sort] || (sort === "store" ? "steam" : "")); if (order) return order; }
    if (sort === "imported") { const order = Number(Boolean(a.imported)) - Number(Boolean(b.imported)); if (order) return order; }
    return compare(a.name, b.name) * (sort === "name-desc" ? -1 : 1);
  });
}
export const allExternalPlatforms = () => new Set<ExternalPlatform>(["macos", "windows", "linux", "web", "android"]);

export function gameVersionLabel(branch: { id: string; name: string; buildId?: string; updatedAt?: string | number | null }) {
  const parts = [branch.name || branch.id];
  if (branch.buildId && !parts[0].includes(branch.buildId)) parts.push(`Build ${branch.buildId}`);
  if (branch.updatedAt) {
    const value = typeof branch.updatedAt === "number" && branch.updatedAt < 1e12 ? branch.updatedAt * 1000 : branch.updatedAt;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) parts.push(date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));
  }
  return parts.join(" · ");
}
export function filterGameVersions<T extends { id: string; name: string; buildId?: string; updatedAt?: string | number | null }>(branches: T[], selectedId: string, query: string, sort: string): T[] {
  const timestamp = (value?: string | number | null) => value ? new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value).getTime() || 0 : 0;
  return branches.filter(item => item.id === selectedId || `${item.name} ${item.id} ${item.buildId || ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) =>
    sort === "date" ? timestamp(b.updatedAt) - timestamp(a.updatedAt) : sort === "build" ? (b.buildId || b.id).localeCompare(a.buildId || a.id, undefined, { numeric: true }) : a.name.localeCompare(b.name));
}
export function VersionFilterTools({ query, onQueryChange, sort, onSortChange }: { query: string; onQueryChange: (value: string) => void; sort: string; onSortChange: (value: string) => void }) {
  return <details className="externalVersionFilters"><summary>Filter versions</summary><div className="externalListTools"><input className="input" aria-label="Search game versions" placeholder="Search versions or build IDs" value={query} onChange={event => onQueryChange(event.target.value)} /><select className="input" aria-label="Sort game versions" value={sort} onChange={event => onSortChange(event.target.value)}><option value="name">Name</option><option value="date">Newest date</option><option value="build">Build ID</option></select></div></details>;
}
const branchMatchesPlatform = (branch: ExternalVersionBranch, platform: ExternalPlatform) =>
  branch.platforms?.length ? branch.platforms.includes(platform) : !branch.platform || branch.platform === platform;
const branchMatchesAndroidProfile = (branch: ExternalVersionBranch, architecture: string, sdk: number) =>
  (branch.abiIndependent || !branch.architectures?.length || branch.architectures.includes(architecture)) &&
  (!branch.minSdk || branch.minSdk <= sdk) && (!branch.maxSdk || sdk <= branch.maxSdk);

export function useDownloadQueueExpansion() {
  const [expanded, setExpanded] = useState(() => typeof window === "undefined" || !window.matchMedia ? true : !window.matchMedia("(max-height: 620px)").matches);
  useEffect(() => {
    const media = window.matchMedia?.("(max-height: 620px)");
    if (!media) return;
    const changed = () => setExpanded(!media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  return [expanded, setExpanded] as const;
}

function StoreIcon({ url }: { url?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  return <span className="steamGameIcon" aria-hidden="true">{url && failed !== url ? <img src={url} alt="" loading="lazy" onError={() => setFailed(url)} /> : <DownloadIcon size="21" />}</span>;
}
function ErrorNotice({ text }: { text: string }) { return <div className="steamNotice error" role="alert">{formatUserError(text)}</div>; }
function StoreEmpty({ title, description }: { title: string; description: string }) {
  return <div className="steamEmpty"><DownloadIcon size="28" /><strong>{title}</strong><p>{description}</p></div>;
}
function bytes(value: number) {
  if (!(value > 0)) return "0 B";
  const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}

export function ExternalStoreView({ store, api, onImported, active = true }: { store: ExternalStore;
  api: ExternalStoreApi & { steamChooseDirectory: () => Promise<string | null> }; onImported: () => unknown; active?: boolean }) {
  const [state, setState] = useState<ExternalStoreSnapshot>(emptyState);
  const [mode, setMode] = useState<"reuse" | "manual" | "public" | "browser" | "microg">("reuse");
  const [itchMode, setItchMode] = useState<"public" | "account">("public");
  const [gameUrl, setGameUrl] = useState("");
  const [addingPublicGame, setAddingPublicGame] = useState(false);
  const [publicStatus, setPublicStatus] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [rememberKey, setRememberKey] = useState(false);
  const [rememberGoogle, setRememberGoogle] = useState(true);
  const [googleAccountId, setGoogleAccountId] = useState("");
  const [accountsBusy, setAccountsBusy] = useState(false);
  const [googleScope, setGoogleScope] = useState<"search" | "owned">("search");
  const [storeQuery, setStoreQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ExternalLibraryGame[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchedStore, setSearchedStore] = useState(false);
  const [searchSources, setSearchSources] = useState<ExternalSearchState["sources"]>([]);
  const [sourceFilters, setSourceFilters] = useState(() => new Set<string>(androidSources.map(item => item.id)));
  const [authBusy, setAuthBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [platformFilters, setPlatformFilters] = useState(allExternalPlatforms);
  const [sort, setSort] = useState<ExternalLibrarySort>("name-asc");
  const [notice, setNotice] = useState("");
  const [selectedGame, setSelectedGame] = useState<ExternalLibraryGame | null>(null);
  const [versions, setVersions] = useState<ExternalStoreVersions | null>(null);
  const [versionError, setVersionError] = useState("");
  const [versionBusy, setVersionBusy] = useState(false);
  const generation = useRef(0);
  const searchGeneration = useRef(0);
  const activeSearchId = useRef("");
  const accountsQueue = useRef<Promise<void>>(Promise.resolve());
  const accountsLifecycle = useRef({ mounted: false, revision: 0 });
  const previousCompleted = useRef("");
  const name = labels[store];
  const connected = state.connection.status === "connected" && (store !== "itch" || (itchMode === "public" ? state.connection.mode === "public" : state.connection.mode !== "public"));
  const publicMode = store === "itch" && itchMode === "public";
  const googlePlay = store === "google-play";
  const searchingStore = googlePlay && (googleScope === "search" || !connected);
  const librarySource = searchingStore ? searchResults : state.library;
  const libraryBusy = searchingStore ? searchBusy : state.libraryLoading;
  const sharedAccounts = state.availableAccounts || [];
  const selectedSharedAccount = sharedAccounts.find(account => account.id === googleAccountId && account.available !== false);
  const connecting = state.connection.status === "connecting";
  const guard = state.connection.status === "guard";
  const fail = useCallback((error: unknown) => setNotice(message(error)), []);
  const readSharedAccounts = useCallback((refresh: boolean) => {
    const lifecycle = accountsLifecycle.current, revision = lifecycle.revision;
    const request = accountsQueue.current.then(async () => {
      if (!lifecycle.mounted || revision !== lifecycle.revision) return;
      const listing = await api.externalAccounts("google-play", refresh);
      if (lifecycle.mounted && revision === lifecycle.revision) setState(current => ({ ...current, availableAccounts: listing.accounts }));
    });
    accountsQueue.current = request.catch(() => {});
    return request;
  }, [api]);
  useEffect(() => {
    let alive = true;
    const lifecycle = accountsLifecycle.current;
    lifecycle.mounted = true; lifecycle.revision++;
    const unsubscribe = api.onExternalState(event => {
      if (!alive || event.store !== store) return;
      setState(event.state);
      if (event.state.search?.requestId === activeSearchId.current && activeSearchId.current) {
        setSearchResults(event.state.search.results); setSearchSources(event.state.search.sources);
        setSearchBusy(event.state.search.loading); setSearchedStore(true);
      }
    });
    void (async () => {
      const next = await api.externalState(store);
      if (!alive) return;
      setState(next);
      if (store === "google-play") await readSharedAccounts(false);
    })().catch(error => { if (alive) fail(error); });
    return () => { alive = false; lifecycle.mounted = false; lifecycle.revision++; unsubscribe(); generation.current++; searchGeneration.current++; };
  }, [store, api, fail, readSharedAccounts]);
  useEffect(() => {
    if (!googlePlay || !active) return;
    const focused = () => {
      const lifecycle = accountsLifecycle.current, revision = lifecycle.revision;
      void readSharedAccounts(false).catch(error => { if (lifecycle.mounted && revision === lifecycle.revision) fail(error); });
    };
    window.addEventListener("focus", focused);
    return () => window.removeEventListener("focus", focused);
  }, [googlePlay, active, readSharedAccounts, fail]);
  useEffect(() => {
    if (state.connection.mode) setMode(state.connection.mode);
  }, [state.connection.mode]);
  useEffect(() => {
    setGoogleAccountId(current => sharedAccounts.some(account => account.id === current && account.available !== false) ? current : sharedAccounts.find(account => account.available !== false)?.id || "");
  }, [state.availableAccounts]);
  useEffect(() => {
    generation.current++; if (store !== "google-play") { searchGeneration.current++; activeSearchId.current = ""; setSearchResults([]); setSearchSources([]); setSearchedStore(false); setSearchBusy(false); } setSelectedGame(null); setVersions(null); setVersionError(""); setVersionBusy(false);
  }, [state.connection.accountName, state.connection.mode, itchMode]);
  const completedKey = state.downloads.filter(job => job.status === "completed").map(job => `${job.id}:${Boolean(job.imported)}`).join("|");
  useEffect(() => {
    if (completedKey && completedKey !== previousCompleted.current) onImported();
    previousCompleted.current = completedKey;
  }, [completedKey, onImported]);
  const library = useMemo(() => sortExternalGames(librarySource.filter(game =>
    query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every(term => `${game.name} ${game.appId} ${game.packageName || ""} ${game.sourceLabel || ""}`.toLocaleLowerCase().includes(term)) &&
    (!googlePlay || sourceFilters.has(androidSource(game))) &&
    (game.platforms.some(platform => platformFilters.has(platform)) || !game.platforms.length && platformFilters.size === allExternalPlatforms().size)), sort), [librarySource, query, platformFilters, sourceFilters, googlePlay, sort]);
  const authenticate = async (event: React.FormEvent) => {
    event.preventDefault(); setAuthBusy(true); setNotice("");
    try {
      if (googlePlay) await api.externalConnect(store, { mode: "browser", remember: rememberGoogle });
      else if (store === "itch") {
        await api.externalConnect(store, apiKey.trim() ? { mode: "manual", apiKey: apiKey.trim(), remember: rememberKey } : { mode: "reuse" });
        setApiKey("");
      } else if (guard && mode === "manual") { await api.externalAuth(store, { code: authCode.trim() }); setAuthCode(""); }
      else await api.externalConnect(store, { mode });
    } catch (error) { fail(error); }
    finally { setAuthBusy(false); }
  };
  const reuseGoogleSignIn = async () => {
    setAuthBusy(true); setNotice("");
    try { await api.externalConnect("google-play", { mode: "reuse" }); }
    catch (error) { fail(error); }
    finally { setAuthBusy(false); }
  };
  const useSharedGoogleAccount = async () => {
    setAuthBusy(true); setNotice("");
    try {
      if (!selectedSharedAccount) throw new Error("Select an available shared Google account.");
      await api.externalConnect("google-play", { mode: "microg", accountId: selectedSharedAccount.id });
    }
    catch (error) { fail(error); }
    finally { setAuthBusy(false); }
  };
  const refreshSharedAccounts = async () => {
    const lifecycle = accountsLifecycle.current, revision = lifecycle.revision;
    setAccountsBusy(true); setNotice("");
    try { await readSharedAccounts(true); }
    catch (error) { if (lifecycle.mounted && revision === lifecycle.revision) fail(error); }
    finally { if (lifecycle.mounted && revision === lifecycle.revision) setAccountsBusy(false); }
  };
  const searchStore = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!storeQuery.trim()) return;
    setSearchBusy(true); setNotice(""); setSearchResults([]); setSearchSources([]); setSearchedStore(true); setGoogleScope("search");
    const request = ++searchGeneration.current;
    const requestId = `android-${Date.now()}-${request}`;
    activeSearchId.current = requestId;
    try { const results = await api.externalSearch(store, storeQuery.trim(), { requestId, sources: androidSources.filter(source => sourceFilters.has(source.id)).map(source => source.id) }); if (request === searchGeneration.current) setSearchResults(results); }
    catch (error) { if (request === searchGeneration.current) fail(error); }
    finally { if (request === searchGeneration.current) setSearchBusy(false); }
  };
  const addPublicGame = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!gameUrl.trim() || addingPublicGame) return;
    setAddingPublicGame(true); setNotice(""); setPublicStatus("");
    try {
      if (!connected) await api.externalConnect("itch", { mode: "public" });
      const next = await api.externalAddGame("itch", gameUrl.trim());
      setState(next); setGameUrl(""); setPublicStatus("Game added.");
    } catch (error) { fail(error); }
    finally { setAddingPublicGame(false); }
  };
  const openPublicLibrary = async () => {
    setAddingPublicGame(true); setNotice(""); setPublicStatus("");
    try {
      const next = await api.externalConnect("itch", { mode: "public" });
      setState(next && typeof next === "object" && "library" in next ? next as ExternalStoreSnapshot : await api.externalState("itch"));
    } catch (error) { fail(error); }
    finally { setAddingPublicGame(false); }
  };
  const openStoreLogin = async () => {
    setAuthBusy(true); setNotice("");
    try {
      if (!guard) await api.externalConnect(store, { mode: "manual" });
      await api.externalOpenLogin(store);
    } catch (error) { fail(error); }
    finally { setAuthBusy(false); }
  };
  const loadVersions = async (game: ExternalLibraryGame, refresh = false) => {
    const request = ++generation.current;
    setSelectedGame(game); setVersions(null); setVersionBusy(true); setVersionError("");
    try { const next = await api.externalVersions(store, game.appId, refresh); if (request === generation.current) {
      setVersions(next);
      if (next.app?.appId === game.appId) {
        const app = next.app;
        setSelectedGame(current => current?.appId === app.appId ? { ...current, ...app, owned: current.owned || app.owned } : current);
        setSearchResults(current => current.map(row => row.appId === app.appId ? { ...row, ...app, owned: row.owned || app.owned } : row));
      }
    } }
    catch (error) { if (request === generation.current) setVersionError(message(error)); }
    finally { if (request === generation.current) setVersionBusy(false); }
  };
  const libraryChanged = (next: ExternalStoreSnapshot) => {
    setState(next);
    const confirmed = new Map(next.library.filter(row => row.owned === true).map(row => [row.appId, row]));
    setSearchResults(current => current.map(row => confirmed.has(row.appId) ? { ...row, ...confirmed.get(row.appId) } : row));
    setSelectedGame(current => current && confirmed.has(current.appId) ? { ...current, ...confirmed.get(current.appId) } : current);
  };
  return <>
    {store === "itch" && <div className="externalModeToolbar"><fieldset className="externalModeSegments" disabled={connecting || authBusy || addingPublicGame}><legend className="externalVisuallyHidden">itch.io library mode</legend>
      <label data-selected={itchMode === "public"}><input type="radio" name="itch-library-mode" value="public" checked={itchMode === "public"} onChange={() => { setItchMode("public"); setNotice(""); setPublicStatus(""); }} /><span>Public games</span></label>
      <label data-selected={itchMode === "account"}><input type="radio" name="itch-library-mode" value="account" checked={itchMode === "account"} onChange={() => { setItchMode("account"); setNotice(""); setPublicStatus(""); }} /><span>Account library</span></label>
    </fieldset><HelpTip label="About itch.io library modes"><p>Public games can be added from an itch.io game page without an API key. Files must be publicly available; purchase, restricted and unpublished uploads require account access.</p><p>Open public library restores saved public game records without fetching pages. The refresh icon checks the saved game URLs.</p><p>An optional API key loads purchased and claimed games. Public and account lists stay separate. Available version history depends on the game publisher.</p></HelpTip></div>}
    {publicMode && <form className="externalPublicGameForm" onSubmit={addPublicGame}>
      <label className="steamField">Game URL<input className="input" type="url" aria-label="itch.io game URL" placeholder="https://author.itch.io/game" value={gameUrl} onChange={event => setGameUrl(event.target.value)} required disabled={addingPublicGame || connecting} autoComplete="url" spellCheck={false} /></label>
      <button className="btn primary" type="submit" disabled={addingPublicGame || connecting || !gameUrl.trim()}>{addingPublicGame ? "Adding…" : "Add game"}</button>
      {!connected && <button className="btn" type="button" disabled={addingPublicGame || connecting} onClick={() => { void openPublicLibrary(); }}>Open public library</button>}
      {publicStatus && <span className="externalPublicStatus" role="status">{publicStatus}</span>}
    </form>}
    {!connected && !publicMode && <div className={`steamLogin${googlePlay ? " externalAndroidLogin" : ""}`}>
      <div className="steamLoginIntro">{googlePlay ? <h2>Google Play account</h2> : <><span className={`steamBadge store-${store}`}>{name}</span><h2>Connect {name}</h2></>}
        <HelpTip label={`About ${name} downloads`}><p>{googlePlay ? "Browser sign-in is shared with Settings → Android. Google handles passwords and account confirmation in a separate window. Existing shared accounts can also be selected without opening an Android sign-in window." : store === "gog" ? "Browse owned games and download available offline installer editions for Mac, Windows and Linux." : store === "itch" ? "Load purchased and claimed games, then choose an available upload and platform before downloading." : "Browse owned games and choose the available platform and build before downloading."}</p><p>Account and version results are cached. Store searches and refresh actions check the network; browsing local installations stays offline.</p></HelpTip>
      </div>
      <form className="steamLoginForm" onSubmit={authenticate}>
        {googlePlay ? <>
          {state.hasSavedSession && <div className="externalSavedAccount"><span>{state.connection.accountName || "Saved Google sign-in"}</span><button className="btn primary" type="button" disabled={authBusy || connecting || guard} onClick={() => { void reuseGoogleSignIn(); }}>Use saved sign-in</button></div>}
          <button className={`btn${state.hasSavedSession ? "" : " primary"}`} type="submit" disabled={authBusy || connecting || guard}>{connecting || authBusy ? "Connecting…" : guard ? "Waiting for Google sign-in…" : "Sign in in browser"}</button>
          <div className="externalControlHelp"><label className="steamInlineCheck"><input type="checkbox" checked={rememberGoogle} onChange={event => setRememberGoogle(event.target.checked)} disabled={authBusy || connecting || guard} />Remember this sign-in</label><HelpTip label="About browser Google sign-in"><p>Browser sign-in opens the same Google account flow as Settings → Android, including email, authenticator and security-key confirmation. Saved accounts are available in both windows.</p></HelpTip></div>
          <details className="externalGoogleExisting"><summary>Use existing account</summary><div className="externalGoogleBrowserOptions">
            <label className="steamField">Shared Google account<select className="input" aria-label="Google Play shared account" value={googleAccountId} disabled={authBusy || connecting || guard || accountsBusy} onChange={event => setGoogleAccountId(event.target.value)}>
              {!selectedSharedAccount && <option value="">Select an account</option>}{sharedAccounts.map(account => <option key={account.id} value={account.id} disabled={account.available === false}>{account.label}{account.source ? ` · ${account.source}` : ""}{account.available === false ? " · unavailable" : ""}</option>)}
            </select></label>
            <div className="steamDestinationActions"><button className="btn small" type="button" disabled={authBusy || connecting || guard || accountsBusy || !selectedSharedAccount} onClick={() => { void useSharedGoogleAccount(); }}>Use selected account</button><button className="btn small iconOnly" type="button" disabled={accountsBusy || authBusy || connecting || guard} aria-label="Reload shared Google accounts" title="Reload shared Google accounts" onClick={() => { void refreshSharedAccounts(); }}><RefreshIcon /></button><button className="btn small" type="button" onClick={() => { void api.externalOpenAccounts("google-play").catch(fail); }}>Google account settings</button><HelpTip label="About shared Google accounts"><p>Existing accounts use the account manager to request Google Play access. Reusing an account does not open an Android sign-in window. Cached names load without starting a runtime; the refresh icon checks existing account managers without contacting Google.</p></HelpTip></div>
            {!selectedSharedAccount && !accountsBusy && !authBusy && !connecting && !guard && <p className="steamBranchNote" role="status">{sharedAccounts.length ? "Refresh accounts or sign in in the browser to reconnect." : "No shared accounts saved. Sign in in the browser to add an account."}</p>}
            {accountsBusy && <p className="steamBranchNote" role="status">Loading shared accounts…</p>}
          </div></details>
          {(connecting || guard || authBusy) && <div className="externalGoogleChallenge"><p className="steamBranchNote" role="status"><span className="steamLoadingDot" />{state.connection.guard?.message || (state.connection.phase === "browser" ? "Complete Google sign-in in the Google window." : "Connecting to Google Play. Account authorization may take a moment.")}</p><div className="steamDestinationActions">{state.connection.phase === "browser" && <button className="btn small" type="button" onClick={() => { void api.externalOpenLogin(store).catch(fail); }}>Open Google window</button>}{guard && state.connection.mode === "microg" && <button className="btn small" type="button" onClick={() => { void api.externalOpenAccounts("google-play").catch(fail); }}>Open account settings</button>}<button className="btn small" type="button" onClick={() => { void api.externalDisconnect(store).catch(fail); }}>Cancel sign-in</button></div></div>}
        </> : store === "itch" ? <>
          <label className="steamField">API key<input className="input" type="password" aria-label="itch.io API key" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} disabled={connecting || authBusy} placeholder={state.hasSavedKey ? "Use saved key, or enter another key" : "Paste an itch.io API key"} /></label>
          <div className="externalControlHelp"><label className="steamInlineCheck"><input type="checkbox" checked={rememberKey} onChange={event => setRememberKey(event.target.checked)} />Save API key</label>
            <HelpTip label="About saving an API key"><p>{rememberKey ? "The API key is saved securely for later connections." : "The API key is used for this session. Saving is optional."}</p></HelpTip></div>
          <button className="btn" type="button" onClick={() => { void api.externalOpenLogin(store).catch(fail); }}>Open API key settings</button>
          <HelpTip label="About itch.io sign-in"><p>Sign in and complete any email or authenticator confirmation on itch.io before creating an API key.</p></HelpTip>
          {state.hasSavedKey && <button className="btn small" type="button" onClick={() => { void api.externalForget(store).catch(fail); }}>Forget saved key</button>}
        </> : <><fieldset className="steamSignInModes" disabled={connecting || authBusy}><legend>Connection <HelpTip label={`About ${name} sign-in`}><p>{mode === "reuse" ? `Reuse an existing ${name} sign-in from a supported local game manager.` : `Sign in to ${name} in the browser and complete any email, authenticator or device confirmation. Paste the resulting authorization code or redirect URL below.`}</p>{state.connection.guard?.message && <p>{state.connection.guard.message}</p>}</HelpTip></legend>
          <label><input type="radio" name={`${store}-sign-in-mode`} value="reuse" checked={mode === "reuse"} onChange={() => setMode("reuse")} /><span>Reuse existing sign-in</span></label>
          <label><input type="radio" name={`${store}-sign-in-mode`} value="manual" checked={mode === "manual"} onChange={() => setMode("manual")} /><span>Sign in manually</span></label>
        </fieldset>
        {mode === "manual" && <>
          <button className="btn" type="button" disabled={authBusy || connecting} onClick={() => { void openStoreLogin(); }}>{`Open ${name} sign-in`}</button>
          <label className="steamField">Authorization code or redirect URL<input className="input" value={authCode} onChange={event => setAuthCode(event.target.value)} autoComplete="off" spellCheck={false} /></label>
        </>}
        </>}
        {!googlePlay && <button className="btn primary" type="submit" disabled={connecting || authBusy || (store === "itch" ? !apiKey.trim() && !state.hasSavedKey : guard && mode === "manual" && !authCode.trim())}>{connecting || authBusy ? "Connecting…" : store !== "itch" && guard && mode === "manual" ? "Complete sign-in" : store === "itch" && !apiKey.trim() && state.hasSavedKey ? "Use saved key" : `Connect ${name}`}</button>}
      </form>
    </div>}
    {notice && <ErrorNotice text={notice} />}
    {state.connection.error && message(state.connection.error) !== notice && <ErrorNotice text={state.connection.error} />}
    {publicMode && !connected && <StoreEmpty title="Add a public game" description="Paste an itch.io game URL to list its public downloads. Opening this panel stays offline." />}
    {(connected || googlePlay) && <>
      {googlePlay && <><div className="externalModeToolbar"><fieldset className="externalModeSegments"><legend className="externalVisuallyHidden">Google Play library scope</legend>
        <label data-selected={searchingStore}><input type="radio" name="google-play-library-scope" value="search" checked={searchingStore} onChange={() => setGoogleScope("search")} /><span>Store search</span></label>
        {state.capabilities?.ownedLibrary !== false && <label data-selected={!searchingStore}><input type="radio" name="google-play-library-scope" value="owned" checked={!searchingStore} disabled={!connected} onChange={() => setGoogleScope("owned")} /><span>Owned library</span></label>}
      </fieldset><HelpTip label="About Google Play libraries"><p>{state.libraryNote || "Owned library lists Google Play purchase history. Free apps can be found with Store search; this list may not include every app previously acquired."}</p><p>Search checks Google Play, F-Droid and IzzyOnDroid independently. F-Droid and IzzyOnDroid work without Google sign-in. A package ID or Google Play URL checks Google Play only; repository URLs and fdroid: or izzy: package prefixes check that source. Typing a list filter stays offline.</p></HelpTip></div>
      {searchingStore && <form className="externalStoreSearchForm" onSubmit={searchStore}><label className="steamField">App name, package ID or store URL<input className="input" aria-label="Google Play store query" value={storeQuery} onChange={event => setStoreQuery(event.target.value)} placeholder="Search apps, fdroid:org.example.app, or a store URL" spellCheck={false} /></label><button className="btn primary" type="submit" disabled={!storeQuery.trim()}>Search</button></form>}
      {searchingStore && searchSources.length > 0 && <div className="externalSearchSources" aria-label="Android search progress" role="status">{searchSources.map(source => <span className={`externalSearchSource ${source.status}`} key={source.id}><span className={`steamBadge store-${source.id}`}>{source.label}</span><span>{source.status === "loading" ? "Searching…" : source.status === "completed" ? `${searchResults.filter(game => androidSource(game) === source.id).length} results` : source.status === "skipped" ? source.id === "google-play" && !connected ? "Sign-in required" : "Skipped" : "Search failed"}</span>{source.error && <HelpTip label={`${source.label} search details`}><p>{formatUserError(source.error)}</p></HelpTip>}</span>)}</div>}</>}
      <div className="steamToolbar"><LibrarySearch query={query} onQueryChange={setQuery} />
        <PlatformTagFilter selected={platformFilters} onChange={setPlatformFilters} includeWeb={store === "itch"} androidOnly={store === "google-play"} label={`Filter ${name} platforms`} />
        <LibrarySortSelect value={sort} onChange={setSort} label={`Sort ${name} library`} access={googlePlay} />
        {googlePlay && <TagCheckboxFilter label="Filter Android sources" options={androidSources} selected={sourceFilters} onChange={setSourceFilters} />}
        <span className="steamCount">{library.length} / {librarySource.length}</span>
        {(query || platformFilters.size !== allExternalPlatforms().size || googlePlay && sourceFilters.size !== androidSources.length) && <button className="btn small" onClick={() => { setQuery(""); setPlatformFilters(allExternalPlatforms()); setSourceFilters(new Set(androidSources.map(item => item.id))); }}>Clear filters</button>}<span className="steamToolbarSpacer" />
        {connected && <span className="steamConnection"><span className="steamDot connected" />{state.connection.displayName || state.connection.accountName || name}</span>}
        {store === "itch" && <><button className="btn small" onClick={() => { setApiKey(""); void api.externalDisconnect(store).catch(fail); }}>Disconnect</button>{state.hasSavedKey && <button className="btn small" onClick={() => { void api.externalForget(store).catch(fail); }}>Forget saved key</button>}</>}
        {googlePlay && connected && <><button className="btn small" onClick={() => { void api.externalDisconnect(store).catch(fail); }}>Disconnect</button>{state.hasSavedSession && <button className="btn small" onClick={() => { void api.externalForget(store).catch(fail); }}>Forget sign-in</button>}</>}
        {state.cancellationNotice && <HelpTip label={`About ${name} download cancellation`}><p>{state.cancellationNotice}</p></HelpTip>}
        <button className="btn small iconOnly" disabled={libraryBusy || searchingStore && !storeQuery.trim() || googlePlay && !searchingStore && !connected} aria-label={`Reload ${name} ${searchingStore ? "search" : "library"}`} title={`Reload ${name} ${searchingStore ? "search" : "library"}`} onClick={() => { if (searchingStore) void searchStore(); else void api.externalLibrary(store, true).catch(fail); }}><RefreshIcon /></button>
      </div>
      {state.libraryError && <ErrorNotice text={state.libraryError} />}
      <div className="steamDownloadWorkspace"><div className="steamLibraryPane"><div className="steamTableScroll">
        <table className="steamTable" aria-label={`${name} ${searchingStore ? "search results" : "account library"}`} aria-busy={libraryBusy}><thead><tr><th>Game</th><th className={googlePlay ? "steamAccessColumn" : "steamPlatformColumn"}>{googlePlay ? "Source / access" : "Platforms"}</th></tr></thead>
          <tbody>{library.map(game => <tr key={game.appId} data-selected={selectedGame?.appId === game.appId}><td><button className="steamLibraryButton" aria-pressed={selectedGame?.appId === game.appId} onClick={() => { void loadVersions(game); }}>
            <span className="steamGameIdentity"><StoreIcon url={game.iconUrl} /><span className="steamGameIdentityText"><span className="steamGameName" title={game.name}>{game.name}</span><span className="steamGameMeta">{game.packageName || game.appId}</span></span></span>
          </button></td><td className={googlePlay ? "steamAccessColumn" : "steamPlatformColumn"}><span className="steamBadges">{googlePlay ? <><span className={`steamBadge store-${androidSource(game)}`}>{androidSourceLabel(game)}</span>{androidSource(game) !== "google-play" ? <span className="steamBadge android">Public</span> : game.owned && <span className="steamBadge imported">Owned</span>}</> : game.platforms.map(os => <span className={`steamBadge ${os}`} key={os}>{platformNames[os]}</span>)}</span></td></tr>)}</tbody>
        </table>
        {!library.length && <StoreEmpty title={libraryBusy ? `Loading ${name} ${searchingStore ? "search…" : "library…"}` : librarySource.length ? "No matching games" : searchingStore ? searchedStore ? "No matching store apps" : "Search Android apps" : "No games in the cached library"} description={searchingStore ? "Search finds Android apps from Google Play, F-Droid and IzzyOnDroid." : "Change the filters or use the refresh icon to load the library."} />}
      </div></div><aside className="steamVersionPane" aria-label={`${name} download options`}>
        {selectedGame ? <><div className="steamVersionIdentity"><StoreIcon url={selectedGame.iconUrl} /><div><h2>{selectedGame.name}</h2><span className="steamGameMeta">{googlePlay ? androidSourceLabel(selectedGame) : name} · {selectedGame.packageName || selectedGame.appId}</span></div></div>
          {versionBusy ? <StoreEmpty title="Loading versions…" description={`Reading available platforms and editions from ${name}.`} /> : versionError ? <><ErrorNotice text={versionError} /><div className="steamVersionScroll"><button className="btn" onClick={() => { void loadVersions(selectedGame, true); }}>Retry</button></div></> : versions &&
            <ExternalVersionOptions key={selectedGame.appId} store={store} game={selectedGame} versions={versions} api={api} downloadRoot={state.defaultDirectory} onError={fail}
              onQueued={() => setNotice("")} onLibraryChanged={libraryChanged} onRefresh={() => { void loadVersions(selectedGame, true); }} />}
        </> : <StoreEmpty title="Choose a game" description="Select a game to view available platforms and downloadable editions." />}
      </aside></div>
    </>}
    {state.downloads.length > 0 && <ExternalQueue store={store} jobs={state.downloads} api={api} onError={fail} />}
  </>;
}

function ExternalVersionOptions({ store, game, versions: initialVersions, api, downloadRoot, onError, onQueued, onRefresh, onLibraryChanged }: {
  store: ExternalStore; game: ExternalLibraryGame; versions: ExternalStoreVersions; api: ExternalStoreApi & { steamChooseDirectory: () => Promise<string | null> };
  downloadRoot?: string; onError: (error: unknown) => void; onQueued: () => void; onRefresh: () => void; onLibraryChanged?: (state: ExternalStoreSnapshot) => void;
}) {
  const [versions, setProfileVersions] = useState(initialVersions);
  const googleSource = store === "google-play" && androidSource(game) === "google-play";
  const providerName = store === "google-play" ? androidSourceLabel(game) : labels[store];
  const downloadStore: ExternalDownloadStore = store === "google-play" ? androidSource(game) : store;
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState("");
  const profileGeneration = useRef(0);
  useEffect(() => () => { profileGeneration.current++; }, []);
  const platforms = versions.platforms.length ? versions.platforms : game.platforms.length ? game.platforms : ["windows"] as ExternalPlatform[];
  const [platform, setPlatform] = useState<ExternalPlatform>(platforms.includes("windows") ? "windows" : platforms[0]);
  const [branch, setBranch] = useState(() => versions.branches.find(item => branchMatchesPlatform(item, platform) && (googleSource || store !== "google-play" || branchMatchesAndroidProfile(item, versions.profile?.architecture || "arm64", versions.profile?.androidSdk || versions.profile?.sdk || 34)))?.id || "");
  const [platformNotice, setPlatformNotice] = useState("");
  const languages = versions.languages?.length ? versions.languages : ["english"];
  const [language, setLanguage] = useState(languages.includes("english") ? "english" : languages[0]);
  const [autoImport, setAutoImport] = useState(true);
  const [destination, setDestination] = useState<string | undefined>();
  const [manifestUrl, setManifestUrl] = useState("");
  const [queueing, setQueueing] = useState(false);
  const [versionQuery, setVersionQuery] = useState("");
  const [versionSort, setVersionSort] = useState("name");
  const [versionCode, setVersionCode] = useState("");
  const [includeExtras, setIncludeExtras] = useState(true);
  const [architecture, setArchitecture] = useState(versions.profile?.architecture || (store === "google-play" ? "arm64" : "all"));
  const [androidSdk, setAndroidSdk] = useState(versions.profile?.androidSdk || versions.profile?.sdk || 34);
  const [addingToLibrary, setAddingToLibrary] = useState(false);
  const [owned, setOwned] = useState(game.owned === true);
  const detailedGame = versions.app ? { ...game, ...versions.app } : game;
  const confirmedOwned = owned || game.owned === true || versions.app?.owned === true;
  const deviceProfiles = versions.deviceProfiles?.filter(profile => (profile.androidSdk || profile.sdk || androidSdk) === androidSdk) || [];
  const profileChoices = deviceProfiles.length ? deviceProfiles : versions.deviceProfiles || [];
  const architectureOptions = [...new Set(profileChoices.length ? profileChoices.map(profile => profile.architecture) : Array.isArray(versions.architectures) ? versions.architectures : versions.architectures?.[platform] || [])];
  const activeArchitecture = architectureOptions.length ? architectureOptions.includes(architecture) ? architecture : architectureOptions[0] : architecture;
  const versionCodeValid = !versionCode.trim() || /^\d+$/.test(versionCode.trim());
  const matchingBranches = versions.branches.filter(item => branchMatchesPlatform(item, platform) && (googleSource || store !== "google-play" || branchMatchesAndroidProfile(item, activeArchitecture, androidSdk)));
  const visibleBranches = filterGameVersions(matchingBranches, branch, versionQuery, versionSort);
  const selectedBranch = matchingBranches.find(item => item.id === branch);
  const architectureLabel = (value: string) => ({ arm64: "ARM 64-bit", armv7: "ARM 32-bit", x86_64: "Intel 64-bit", x86: "Intel 32-bit", all: "All available" } as Record<string, string>)[value] || value;
  const loadProfile = async (nextArchitecture: string, nextLanguage = language, nextSdk = androidSdk, refresh = false) => {
    setArchitecture(nextArchitecture); setLanguage(nextLanguage); setAndroidSdk(nextSdk); setProfileBusy(true); setProfileError("");
    const request = ++profileGeneration.current;
    try {
      const next = await api.externalVersions(store, game.appId, refresh, { architecture: nextArchitecture, language: nextLanguage, androidSdk: nextSdk });
      if (request !== profileGeneration.current) return;
      setProfileVersions(next);
      const choices = next.branches.filter(item => branchMatchesPlatform(item, platform) && (googleSource ? !item.architectures?.length || item.architectures.includes(nextArchitecture) : branchMatchesAndroidProfile(item, nextArchitecture, nextSdk)));
      if (choices.some(item => item.id === branch)) setPlatformNotice("");
      else { setBranch(choices[0]?.id || ""); setPlatformNotice(choices[0] ? `Version changed to ${gameVersionLabel(choices[0])} for ${architectureLabel(nextArchitecture)} · API ${nextSdk}.` : next.unavailableReason || `No published builds are available for ${architectureLabel(nextArchitecture)} · API ${nextSdk}.`); }
    } catch (error) { if (request === profileGeneration.current) setProfileError(message(error)); }
    finally { if (request === profileGeneration.current) setProfileBusy(false); }
  };
  const addToLibrary = async () => {
    setAddingToLibrary(true);
    try {
      const next = await api.externalAddToLibrary("google-play", game.appId, { architecture: activeArchitecture, language, androidSdk });
      onLibraryChanged?.(next);
      if (!next.library.some(row => row.appId === game.appId && row.owned === true)) throw new Error("Google Play did not confirm this app in the library.");
      setOwned(true);
    } catch (error) { onError(error); }
    finally { setAddingToLibrary(false); }
  };
  const changePlatform = (next: ExternalPlatform) => {
    setPlatform(next);
    const choices = versions.branches.filter(item => branchMatchesPlatform(item, next));
    if (choices.some(item => item.id === branch)) setPlatformNotice("");
    else {
      setBranch(choices[0]?.id || "");
      setPlatformNotice(choices[0] ? `Version changed to ${gameVersionLabel(choices[0])} for ${platformNames[next]}.` : `No published builds are available for ${platformNames[next]}.`);
    }
  };
  const queue = async () => {
    setQueueing(true);
    try {
      await api.externalDownload(store, { appId: game.appId, name: game.name, platform, branch: versions.supportsVersionCode && versionCode.trim() ? versionCode.trim() : branch, language, architecture: activeArchitecture, autoImport,
        ...(destination ? { destination } : {}), ...(manifestUrl.trim() ? { manifestUrl: manifestUrl.trim() } : {}),
        ...(versions.supportsVersionCode && versionCode.trim() ? { versionCode: versionCode.trim() } : {}), ...(store === "google-play" ? { androidSdk, ...(googleSource ? { includeExtras } : {}) } : {}) });
      onQueued();
    } catch (error) { onError(error); }
    finally { setQueueing(false); }
  };
  return <><div className="steamVersionScroll">
    <section className="steamVersionSection"><h3 className="steamVersionSectionTitle externalControlHelp">Game version <HelpTip label={`About ${providerName} game versions`}>{selectedBranch?.description && <p>{selectedBranch.description}</p>}{versions.historyNote && <p>{versions.historyNote}</p>}</HelpTip></h3><div className="steamFieldGrid">
      <label className="steamField full">Version / build<select className="input" aria-label={`${providerName} download version`} value={branch} onChange={event => { setBranch(event.target.value); setPlatformNotice(""); }}>{matchingBranches.length ? visibleBranches.map(item => <option key={item.id} value={item.id}>{gameVersionLabel(item)}</option>) : <option value="">No builds available</option>}</select></label>
      <div className="steamField full"><VersionFilterTools query={versionQuery} onQueryChange={setVersionQuery} sort={versionSort} onSortChange={setVersionSort} /></div>
      <label className="steamField">Platform<select className="input" aria-label={`${providerName} download platform`} value={platform} onChange={event => changePlatform(event.target.value as ExternalPlatform)}>{platforms.map(os => <option key={os} value={os}>{platformNames[os]}</option>)}</select></label>
      <label className="steamField">Language<select className="input" value={language} disabled={profileBusy} onChange={event => { if (store === "google-play") void loadProfile(activeArchitecture, event.target.value); else setLanguage(event.target.value); }}>{languages.map(item => <option key={item} value={item}>{item.charAt(0).toUpperCase() + item.slice(1)}</option>)}</select></label>
      {architectureOptions.length > 0 && <label className="steamField full"><span className="externalControlHelp">{store === "google-play" ? "Android ABI" : "Architecture"}{store === "google-play" && <HelpTip label={`About ${providerName} device profiles`}><p>These choices request an Android device profile. Each source determines compatible files and may return a different version code for each ABI and Android API level. Changing either checks its available version.</p><p>Unavailable describes the current profile. Other API levels or a known earlier version code can have different availability.</p></HelpTip>}</span><select className="input" aria-label={`${providerName} download architecture`} value={activeArchitecture} disabled={profileBusy} onChange={event => { if (store === "google-play") void loadProfile(event.target.value); else setArchitecture(event.target.value); }}>{architectureOptions.map(value => { const profile = deviceProfiles.find(item => item.architecture === value); return <option key={value} value={value}>{architectureLabel(value)}{profile?.available === false ? " · unavailable" : profile?.available === null ? " · check availability" : ""}</option>; })}</select></label>}
      {store === "google-play" && (googleSource || Boolean(versions.sdkVersions?.length)) && <label className="steamField full"><span className="externalControlHelp">Android API level <HelpTip label="About Android API levels"><p>CPU architecture and Android API level are independent device settings. Modern API levels are the default for every ABI. An older API level can request editions published for older Android devices; availability depends on published app metadata and store access.</p></HelpTip></span><select className="input" aria-label={`${providerName} Android API level`} value={androidSdk} disabled={profileBusy} onChange={event => { void loadProfile(activeArchitecture, language, Number(event.target.value)); }}>{(versions.sdkVersions?.length ? versions.sdkVersions : [androidSdk]).map(sdk => <option key={sdk} value={sdk}>API {sdk}</option>)}</select></label>}
    </div>{platformNotice && <p className="steamBranchNote" role="status">{platformNotice}</p>}
      {selectedBranch?.buildId && <p className="steamBranchNote">Build {selectedBranch.buildId}</p>}
      {store === "google-play" && !googleSource && selectedBranch && (selectedBranch.minSdk || selectedBranch.maxSdk || selectedBranch.abiIndependent || selectedBranch.architectures?.length) && <p className="steamBranchNote">{[selectedBranch.minSdk ? `Requires API ${selectedBranch.minSdk}${selectedBranch.maxSdk ? `–${selectedBranch.maxSdk}` : "+"}` : selectedBranch.maxSdk ? `Up to API ${selectedBranch.maxSdk}` : "", selectedBranch.targetSdk ? `Targets API ${selectedBranch.targetSdk}` : "", selectedBranch.abiIndependent ? "ABI independent" : selectedBranch.architectures?.map(architectureLabel).join(", ")].filter(Boolean).join(" · ")}</p>}
      {googleSource && <div className="externalAddLibraryControl">{confirmedOwned ? <span className="steamBadge imported">Owned</span> : detailedGame.priceMicros === "0" && detailedGame.checkoutRequired === false && detailedGame.canAddToLibrary === true && <button className="btn small" disabled={addingToLibrary || profileBusy || Boolean(profileError)} onClick={() => { void addToLibrary(); }}>{addingToLibrary ? "Adding…" : "Add to library"}</button>}</div>}
      {profileBusy && <p className="steamBranchNote" role="status"><span className="steamLoadingDot" />Loading the selected device profile…</p>}
      {profileError && <ErrorNotice text={profileError} />}
      {versions.available === false && !profileBusy && <p className="steamBranchNote" role="status">{versions.unavailableReason || "This app is unavailable for the selected device profile."}</p>}
    </section>
    {googleSource && versions.supportsVersionCode && <details className="steamHistory steamVersionSection"><summary>Known version code</summary><HelpTip label="About Google Play version codes"><p>{versions.historyNote || "Google Play returns the version currently available to the selected account and device configuration. An earlier version can be requested by its known numeric version code; availability depends on publisher and account access."}</p><p>The requested code is used exactly. This field does not search for historical releases.</p></HelpTip><label className="steamField">Version code<input className="input" inputMode="numeric" aria-label="Google Play version code" value={versionCode} onChange={event => setVersionCode(event.target.value.trim())} aria-invalid={!versionCodeValid} placeholder={selectedBranch?.versionCode || selectedBranch?.buildId || "Known numeric version code"} /></label>{versionCode.trim() && versionCodeValid && <p className="steamBranchNote" role="status">Requested version code {versionCode.trim()}</p>}{!versionCodeValid && <p className="steamHistoryStatus error" role="alert">Version code must contain digits only.</p>}</details>}
    {googleSource && <div className="externalControlHelp externalAndroidExtras"><label className="steamInlineCheck"><input type="checkbox" checked={includeExtras} onChange={event => setIncludeExtras(event.target.checked)} />Include expansion files and asset packs</label><HelpTip label="About Android download files"><p>The base APK and required APK splits are downloaded together for the selected Android ABI. Additional expansion files and asset packs are included when available.</p></HelpTip></div>}
    {versions.supportsManifestOverride && <details className="steamHistory steamVersionSection"><summary>Previous manifest</summary><HelpTip label="About previous Epic manifests"><p>Use a known manifest URL to request an earlier build. Availability depends on store access.</p></HelpTip>
      <label className="steamField">Manifest URL<input className="input" type="url" value={manifestUrl} onChange={event => setManifestUrl(event.target.value)} placeholder="https://…" spellCheck={false} /></label>
    </details>}
    <section className="steamVersionSection externalDestination"><h3 className="steamVersionSectionTitle externalControlHelp">Download location <HelpTip label="About downloaded copies"><p>A separate folder is created for this edition. Downloaded copies keep their selected version independently of store installations.</p></HelpTip></h3><div className="steamDestination"><div className="steamDestinationPath" title={destination || versions.defaultDirectory || downloadRoot}>{destination || versions.defaultDirectory || downloadRoot || `MacLauncher Application Support · ${providerName} downloads`}</div>
      <div className="steamDestinationActions"><button className="btn small" onClick={() => { void api.steamChooseDirectory().then(folder => { if (folder) setDestination(folder); }).catch(onError); }}>Choose folder…</button>
        <button className="btn small" onClick={() => { void api.externalOpenDownloads(downloadStore).catch(onError); }}>Open default in Finder</button>{destination && <button className="btn small" onClick={() => setDestination(undefined)}>Use managed location</button>}</div>
      </div></section>
    <button className="btn small iconOnly" disabled={profileBusy} aria-label={`Reload ${providerName} versions`} title={`Reload ${providerName} versions`} onClick={() => { if (store === "google-play") void loadProfile(activeArchitecture, language, androidSdk, true); else onRefresh(); }}><RefreshIcon /></button>
  </div><div className="steamDownloadActions"><label className="steamInlineCheck"><input type="checkbox" checked={autoImport} onChange={event => setAutoImport(event.target.checked)} />Import into MacLauncher when the download finishes</label>
    <button className="btn primary" disabled={queueing || profileBusy || Boolean(profileError) || !versionCodeValid || !selectedBranch && !(versions.supportsVersionCode && versionCode.trim())} onClick={() => { void queue(); }}><DownloadIcon />{queueing ? "Queueing…" : "Download"}</button>
  </div></>;
}

function ExternalQueue({ store, jobs, api, onError }: { store: ExternalStore; jobs: ExternalDownload[]; api: ExternalStoreApi; onError: (error: unknown) => void }) {
  const [importing, setImporting] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useDownloadQueueExpansion();
  const labelsByStatus: Record<string, string> = { queued: "Queued", preparing: "Preparing", downloading: "Downloading", completed: "Downloaded", cancelled: "Cancelled", error: "Failed" };
  return <details className="steamJobs" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>{labels[store]} downloads · {jobs.filter(job => active(job.status)).length || jobs.length}</summary>
    {jobs.map(job => <div className="steamJob" key={job.id}><div className="steamJobTop"><span className="steamJobName">{job.name} <span className="steamJobStatus">· {platformNames[job.platform]} · {job.branch}</span></span>
      <div className="steamJobActions">{job.imported ? <span className="steamBadge imported">Imported</span> : <span className="steamJobStatus">{labelsByStatus[job.status] || job.status}</span>}
        {active(job.status) && <button className="btn small" onClick={() => { void api.externalCancel(store, job.id).catch(onError); }}>Cancel</button>}
        {job.status === "completed" && !job.imported && <button className="btn small" disabled={importing.has(job.id) && !job.importError} onClick={() => {
          setImporting(current => new Set([...current, job.id]));
          void api.externalImportDownload(store, job.id).catch(error => { setImporting(current => { const next = new Set(current); next.delete(job.id); return next; }); onError(error); });
        }}>{importing.has(job.id) && !job.importError ? "Importing…" : "Import"}</button>}
      </div></div>
      {active(job.status) && (job.total > 0 ? <progress max={job.total} value={job.downloaded} aria-label={`Download progress for ${job.name}`} /> : <progress aria-label={`Preparing download for ${job.name}`} />)}
      {job.total > 0 && active(job.status) && <p className="steamJobDetail">{bytes(job.downloaded)} of {bytes(job.total)}</p>}
      <p className={`steamJobDetail ${job.error || job.importError ? "error" : ""}`}>{job.error || job.importError || job.detail || job.path}</p>
    </div>)}
  </details>;
}
