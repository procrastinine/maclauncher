import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DownloadIcon, RefreshIcon, XIcon } from "../icons";
import { LibrarySearch } from "./LibraryToolbar";
import { ExternalStoreView, gameVersionLabel, useDownloadQueueExpansion, PlatformTagFilter, TagCheckboxFilter, LibrarySortSelect, sortExternalGames, allExternalPlatforms, VersionFilterTools, filterGameVersions } from "./ExternalStoreView";
import type { ExternalStoreApi, ExternalLibrarySort, ExternalPlatform } from "./ExternalStoreView";
import { HelpTip } from "./HelpTip";
import { ScrollableTabStrip } from "./ScrollableTabStrip";
import { formatUserError } from "../ui-helpers";
import "./SteamView.css";
import { libraryLocationLabel } from "./path-display-model";

export type SteamPlatform = "macos" | "windows" | "linux" | "android";
export type SteamInstalledGame = {
  id: string; appId: string; name: string; path: string; gamePath: string;
  platform: SteamPlatform | "web" | "android"; platformSource?: "manifest" | "binary" | "client"; source: string; store?: "steam" | "epic" | "gog" | "itch" | "google-play" | "fdroid" | "izzy";
  libraryPath: string; bottle?: string | null; iconUrl?: string | null; imported: boolean;
  version?: string; versionName?: string; buildId?: string; branch?: string;
  architectures?: string[]; architectureCpu?: string[]; architectureLabel?: string; architectureSource?: string;
};
export type SteamLibraryGame = { appId: string; name: string; platforms: SteamPlatform[]; shared: boolean; iconUrl?: string | null;
  architecturesByPlatform?: Partial<Record<SteamPlatform, string[]>>; nativeAppleSilicon?: boolean };
export type SteamManifest = { id: string; size?: number; downloadSize?: number };
export type SteamDepot = {
  id: string; name: string; platforms: SteamPlatform[]; architectures: string[]; languages: string[];
  manifests: Record<string, SteamManifest>; encryptedBranches: string[];
  architectureBits?: string[]; architectureCpu?: string[]; architectureSource?: string;
};
export type SteamHistoryEntry = { depotId: string; manifestId: string; branch?: string; observedAt?: string; date?: string };
export type SteamHistoryResult = { history: SteamHistoryEntry[]; sourceUrl: string; blocked?: boolean; message?: string; sources: Array<{ depotId: string; url: string }>; fetchedAt: string };
export type SteamVersions = {
  appId: string; name: string; platforms: SteamPlatform[];
  branches: Array<{ id: string; name: string; description?: string; buildId?: string; updatedAt?: string | number; passwordRequired?: boolean }>;
  depots: SteamDepot[];
  history: SteamHistoryEntry[];
  historyNote?: string;
  architectureSchema?: number; architectures?: Partial<Record<SteamPlatform, string[]>>;
  architectureLabels?: Partial<Record<SteamPlatform, Record<string, string>>>; architectureNotes?: Partial<Record<SteamPlatform, string>>;
  launchOptions?: Array<{ id: string; executable: string; description?: string; platforms: SteamPlatform[]; architectures: string[]; architectureBits?: string[]; architectureCpu?: string[]; architectureSource?: string }>;
};
export type SteamDownload = {
  id: string; status: "queued" | "preparing" | "downloading" | "completed" | "cancelled" | "error";
  name: string; appId: string; platform: SteamPlatform; branch: string; path: string;
  downloaded: number; total: number; detail?: string; error?: string; importError?: string; autoImport: boolean; imported?: boolean; accountName?: string;
};
export type SteamImportJob = { id: string; sourceId?: string; name: string; status: string; error?: string };
export type SteamAccount = { id: string; accountName: string; mode: "client" | "manual"; status: string };
export type SteamGuard = { kind: "email" | "totp" | "mobile" | "email-approval" | "qr"; domain?: string; message?: string;
  codeKinds?: Array<"email" | "totp">; qrChallengeUrl?: string; qrImageUrl?: string; remoteInteraction?: boolean; lastCodeWrong?: boolean; error?: string };
export type SteamSnapshot = {
  connection: { status: "disconnected" | "connecting" | "guard" | "connected" | "error"; accountName?: string; mode?: "client" | "manual"; error?: string; sessionError?: string;
    guard?: SteamGuard };
  library: SteamLibraryGame[]; libraryLoading: boolean; libraryFetchedAt?: string | number | null; libraryError?: string | null;
  downloads: SteamDownload[]; imports?: SteamImportJob[];
  defaultDirectory?: string; accounts?: SteamAccount[]; activeAccountId?: string; cancellationNotice?: string;
};
export type SteamDownloadSelection = {
  appId: string; name: string; platform: SteamPlatform; branch: string; language: string; architecture: string;
  depots: Array<{ depotId: string; manifestId?: string }>; branchPassword?: string; autoImport: boolean; destination?: string;
};
export type SteamApi = ExternalStoreApi & {
  steamState: () => Promise<SteamSnapshot>;
  steamScan: () => Promise<SteamInstalledGame[]>;
  externalDownloaded: () => Promise<SteamInstalledGame[]>;
  externalImportCopies: (ids: string[]) => Promise<unknown>;
  steamImport: (ids: string[]) => Promise<unknown>;
  steamImportDownload: (id: string) => Promise<unknown>;
  steamConnect: (credentials: { mode: "client" | "manual"; accountName?: string; password?: string; remember?: boolean; authMethod?: "password" | "qr" }) => Promise<unknown>;
  steamSelectAccount: (id: string) => Promise<unknown>;
  steamRemoveAccount: (id: string) => Promise<unknown>;
  steamAuth: (response: { code: string }) => Promise<unknown>;
  steamDisconnect: () => Promise<unknown>;
  steamLibrary: (refresh: boolean) => Promise<unknown>;
  steamVersions: (appId: string, refresh: boolean) => Promise<SteamVersions>;
  steamPreviousVersions: (appId: string, depotIds: string[], refresh?: boolean) => Promise<SteamHistoryResult>;
  steamOpenHistory: (appId: string, depotId?: string) => Promise<unknown>;
  steamDownload: (selection: SteamDownloadSelection) => Promise<unknown>;
  steamCancel: (id: string) => Promise<unknown>;
  steamChooseDirectory: () => Promise<string | null>;
  onSteamState: (callback: (state: SteamSnapshot) => void) => () => void;
};

const emptySnapshot: SteamSnapshot = { connection: { status: "disconnected" }, library: [], libraryLoading: false, downloads: [] };
const platformNames: Record<SteamPlatform | "web" | "android", string> = { macos: "Mac", windows: "Windows", linux: "Linux", web: "Web", android: "Android" };
const sourceNames: Record<string, string> = { steam: "Steam", crossover: "CrossOver", managed: "MacLauncher", epic: "Epic Games", gog: "GOG", itch: "itch.io", "google-play": "Google Play", fdroid: "F-Droid", izzy: "IzzyOnDroid", heroic: "Heroic", legendary: "Legendary" };
const storeNames = { steam: "Steam", epic: "Epic", gog: "GOG", itch: "itch.io", "google-play": "Google Play", fdroid: "F-Droid", izzy: "IzzyOnDroid" };
const errorMessage = formatUserError;
const isActive = (status: string) => ["queued", "preparing", "downloading", "importing", "running"].includes(status);
const gameMatches = (game: { name: string; appId: string }, query: string, extra = "") =>
  query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every(term => `${game.name} ${game.appId} ${extra}`.toLocaleLowerCase().includes(term));
// A store build number identifies a pinned downloaded copy; for an installed
// game it is not a version, so it stays in the cell's tooltip.
const installedVersion = (game: SteamInstalledGame, buildFallback = true) => {
  const version = [game.versionName, game.version].find(value => typeof value === "string" && value.trim() && !/^(?:unknown|undefined|null|n\/a|none|-|—)$/i.test(value.trim()));
  return version?.trim() || (buildFallback && game.buildId ? `Build ${game.buildId}` : "—");
};
export function normalizeSteamVersions(versions: SteamVersions): SteamVersions {
  return { ...versions, appId: String(versions.appId),
    branches: versions.branches.map(branch => ({ ...branch, id: String(branch.id) })),
    depots: versions.depots.map(depot => ({ ...depot, id: String(depot.id), manifests: Object.fromEntries(Object.entries(depot.manifests).map(([branch, manifest]) => [branch, { ...manifest, id: String(manifest.id) }])) })),
    history: versions.history.map(entry => ({ ...entry, depotId: String(entry.depotId), manifestId: String(entry.manifestId) })) };
}

function formatBytes(value: number | string | undefined) {
  let amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount.toFixed(unit > 1 && amount < 10 ? 1 : 0)} ${units[unit]}`;
}

export function SteamMark({ size = 22 }: { size?: number }) {
  return <span className="steamMark" aria-hidden="true"><svg viewBox="0 0 24 24" width={size} height={size} fill="none">
    <circle cx="12" cy="12" r="10.25" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="15.9" cy="8.1" r="3.6" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="15.9" cy="8.1" r="1.9" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="8.1" cy="15.6" r="2.7" stroke="currentColor" strokeWidth="1.5" />
    <path d="m9.6 13.4 3.2-3M10.7 16.2l5.9-4.6M1.9 12.9l5.1 2.9" stroke="currentColor" strokeWidth="1.6" />
  </svg></span>;
}

export function ExternalMark({ size = 22 }: { size?: number }) {
  return <span className="steamMark" aria-hidden="true"><svg viewBox="0 0 24 24" width={size} height={size} fill="none">
    <path d="M4 8.5 12 4l8 4.5V18l-8 4-8-4V8.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <path d="m4 8.5 8 4 8-4M12 12.5V22M12 1v7m-3-3 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg></span>;
}

function SteamGameIcon({ name, url }: { name: string; url?: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // Steam artwork is local or supplied by the connected account. Opening Installed never loads remote artwork.
  return <span className="steamGameIcon" aria-hidden="true">
    {url && failedUrl !== url ? <img src={url} alt="" loading="lazy" onError={() => setFailedUrl(url)} /> :
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="M7 7h10c2 0 3 2 3.4 4l.7 4c.5 2.6-2.2 4-4 2l-1.8-2H8.7l-1.8 2c-1.8 2-4.5.6-4-2l.7-4C4 9 5 7 7 7Z" stroke="currentColor" strokeWidth="1.5" /><path d="M8 9.5v5m-2.5-2.5h5" stroke="currentColor" strokeWidth="1.5" /><circle cx="16" cy="11" r="1" fill="currentColor" /><circle cx="18" cy="13.5" r="1" fill="currentColor" /></svg>}
  </span>;
}

function PlatformBadge({ platform, inferred = false }: { platform: SteamPlatform | "web" | "android"; inferred?: boolean }) {
  return <span className={`steamBadge ${platform}`} title={inferred ? "Platform inferred from the installation location." : undefined}>{platformNames[platform] || platform}</span>;
}

function Notice({ text, kind = "error", onDismiss }: { text: string; kind?: "error" | "success" | "info"; onDismiss?: () => void }) {
  return <div className={`steamNotice ${kind}`} role={kind === "error" ? "alert" : "status"}><span>{formatUserError(text)}</span>
    {onDismiss && <button className="searchClear" aria-label="Dismiss message" onClick={onDismiss}><XIcon size="14" /></button>}
  </div>;
}

function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="steamEmpty"><ExternalMark size={34} /><strong>{title}</strong>{children && <HelpTip label="About this view"><p>{children}</p></HelpTip>}</div>;
}

export function SteamView({ api }: { api: SteamApi }) {
  const [tab, setTab] = useState<"installed" | "downloaded" | "download" | "epic" | "gog" | "itch" | "google-play">("installed");
  const [visitedStores, setVisitedStores] = useState<Set<"epic" | "gog" | "itch" | "google-play">>(new Set());
  const [snapshot, setSnapshot] = useState<SteamSnapshot>(emptySnapshot);
  const [installed, setInstalled] = useState<SteamInstalledGame[]>([]);
  const [downloaded, setDownloaded] = useState<SteamInstalledGame[]>([]);
  const [scanning, setScanning] = useState(true);
  const [downloadedScanning, setDownloadedScanning] = useState(true);
  const [query, setQuery] = useState("");
  const [platformFilters, setPlatformFilters] = useState(allExternalPlatforms);
  const [importFilters, setImportFilters] = useState(() => new Set(["new", "imported"]));
  const [storeFilters, setStoreFilters] = useState(() => new Set(Object.keys(storeNames)));
  const [cpuFilters, setCpuFilters] = useState(() => new Set(["arm64", "x86", "unknown"]));
  const [localSort, setLocalSort] = useState<ExternalLibrarySort>("name-asc");
  const [librarySort, setLibrarySort] = useState<ExternalLibrarySort>("name-asc");
  const [accessFilter, setAccessFilter] = useState("all");
  const [nativeMacOnly, setNativeMacOnly] = useState(false);
  const [installedSelected, setInstalledSelected] = useState<Set<string>>(new Set());
  const [downloadedSelected, setDownloadedSelected] = useState<Set<string>>(new Set());
  const [installedAnchor, setInstalledAnchor] = useState<string | null>(null);
  const [downloadedAnchor, setDownloadedAnchor] = useState<string | null>(null);
  const [queueingImport, setQueueingImport] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: "error" | "success" | "info" } | null>(null);
  const [selectedApp, setSelectedApp] = useState<SteamLibraryGame | null>(null);
  const [versions, setVersions] = useState<SteamVersions | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState("");
  const [accountName, setAccountName] = useState("");
  const [signInMode, setSignInMode] = useState<"client" | "manual">("client");
  const [addingAccount, setAddingAccount] = useState(false);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [authCode, setAuthCode] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const scanGeneration = useRef(0);
  const downloadedGeneration = useRef(0);
  const versionsGeneration = useRef(0);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const previousImportState = useRef("");
  const accountHintInitialized = useRef(false);
  const connected = snapshot.connection.status === "connected";
  const connecting = snapshot.connection.status === "connecting";
  const guarding = snapshot.connection.status === "guard";
  const browsingDownloads = tab === "downloaded";
  const localGames = browsingDownloads ? downloaded : installed;
  const localPlatformCounts = useMemo(() => localGames.reduce<Partial<Record<ExternalPlatform, number>>>((counts, game) => {
    if (game.platform) counts[game.platform as ExternalPlatform] = (counts[game.platform as ExternalPlatform] || 0) + 1;
    return counts;
  }, {}), [localGames]);
  const localScanning = browsingDownloads ? downloadedScanning : scanning;
  const selected = browsingDownloads ? downloadedSelected : installedSelected;
  const setSelected = browsingDownloads ? setDownloadedSelected : setInstalledSelected;
  const anchor = browsingDownloads ? downloadedAnchor : installedAnchor;
  const setAnchor = browsingDownloads ? setDownloadedAnchor : setInstalledAnchor;
  const showError = useCallback((error: unknown) => setNotice({ text: errorMessage(error), kind: "error" }), []);
  const updateSnapshot = useCallback((next: SteamSnapshot) => {
    setSnapshot(next);
    if (!accountHintInitialized.current && next.connection.accountName) {
      accountHintInitialized.current = true;
      setAccountName(current => current || next.connection.accountName || "");
    }
  }, []);
  const scan = useCallback(async () => {
    const generation = ++scanGeneration.current;
    setScanning(true);
    try {
      const games = (await api.steamScan()).filter(game => game.source !== "managed");
      if (generation !== scanGeneration.current) return;
      setInstalled(games);
      const available = new Set(games.filter(game => !game.imported).map(game => game.id));
      setInstalledSelected(current => new Set([...current].filter(id => available.has(id))));
    } catch (error) { if (generation === scanGeneration.current) showError(error); }
    finally { if (generation === scanGeneration.current) setScanning(false); }
  }, [api, showError]);
  const scanDownloaded = useCallback(async () => {
    const generation = ++downloadedGeneration.current;
    setDownloadedScanning(true);
    try {
      const games = await api.externalDownloaded();
      if (generation !== downloadedGeneration.current) return;
      setDownloaded(games);
      const available = new Set(games.filter(game => !game.imported).map(game => game.id));
      setDownloadedSelected(current => new Set([...current].filter(id => available.has(id))));
    } catch (error) { if (generation === downloadedGeneration.current) showError(error); }
    finally { if (generation === downloadedGeneration.current) setDownloadedScanning(false); }
  }, [api, showError]);
  const refreshLocal = useCallback(async () => { await Promise.all([scan(), scanDownloaded()]); }, [scan, scanDownloaded]);

  useEffect(() => {
    let alive = true;
    const unsubscribe = api.onSteamState(next => { if (alive) updateSnapshot(next); });
    void api.steamState().then(next => { if (alive) updateSnapshot(next); }).catch(showError);
    void scan();
    void scanDownloaded();
    return () => { alive = false; unsubscribe(); scanGeneration.current++; downloadedGeneration.current++; versionsGeneration.current++; };
  }, [api, scan, scanDownloaded, showError, updateSnapshot]);

  const importStateKey = (snapshot.imports || []).filter(job => ["completed", "error"].includes(job.status)).map(job => `${job.id}:${job.status}`).join("|");
  useEffect(() => {
    if (importStateKey && previousImportState.current !== importStateKey) void refreshLocal();
    previousImportState.current = importStateKey;
  }, [importStateKey, refreshLocal]);
  const steamCompletedKey = snapshot.downloads.filter(job => job.status === "completed").map(job => job.id).join("|");
  useEffect(() => { if (steamCompletedKey) void scanDownloaded(); }, [steamCompletedKey, scanDownloaded]);

  useEffect(() => {
    const handleSearch = (event: KeyboardEvent) => {
      if (event.key.toLocaleLowerCase() !== "f" || !event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      document.getElementById(`steam-${tab}-panel`)?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    };
    window.addEventListener("keydown", handleSearch);
    return () => window.removeEventListener("keydown", handleSearch);
  }, [tab]);

  useEffect(() => {
    if (["connecting", "guard"].includes(snapshot.connection.status) && snapshot.connection.mode) setSignInMode(snapshot.connection.mode);
  }, [snapshot.connection.mode, snapshot.connection.status]);

  useEffect(() => {
    // Version requests and selected depots belong to the account that opened them.
    versionsGeneration.current++;
    setSelectedApp(null); setVersions(null); setVersionsLoading(false); setVersionsError("");
  }, [snapshot.activeAccountId]);

  const visibleInstalled = useMemo(() => sortExternalGames(localGames.filter(game =>
    gameMatches(game, query, `${game.path} ${sourceNames[game.source] || game.source} ${storeNames[game.store || "steam"]} ${game.bottle || ""}`) &&
    storeFilters.has(game.store || "steam") && platformFilters.has(game.platform) && importFilters.has(game.imported ? "imported" : "new") &&
    (cpuFilters.size === 3 || (!game.architectureCpu?.length ? cpuFilters.has("unknown") : game.architectureCpu.some(cpu => cpuFilters.has(cpu === "arm64" ? "arm64" : cpu === "universal" ? "arm64" : "x86") || cpu === "universal" && cpuFilters.has("x86"))))), localSort),
    [localGames, query, platformFilters, importFilters, storeFilters, cpuFilters, localSort]);
  const selectable = visibleInstalled.filter(game => !game.imported).map(game => game.id);
  const visibleChecked = selectable.filter(id => selected.has(id)).length;
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = visibleChecked > 0 && visibleChecked < selectable.length; }, [visibleChecked, selectable.length]);

  const selectGame = (id: string, range: boolean) => {
    setSelected(current => {
      const next = new Set(current);
      const checking = !current.has(id);
      const first = anchor ? selectable.indexOf(anchor) : -1;
      const last = selectable.indexOf(id);
      const ids = range && first >= 0 && last >= 0 ? selectable.slice(Math.min(first, last), Math.max(first, last) + 1) : [id];
      for (const gameId of ids) { if (checking) next.add(gameId); else next.delete(gameId); }
      return next;
    });
    if (!range || !anchor) setAnchor(id);
  };
  const importGames = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setQueueingImport(true);
    try {
      if (browsingDownloads) await api.externalImportCopies(ids);
      else await api.steamImport(ids);
      setSelected(current => new Set([...current].filter(id => !ids.includes(id))));
      setNotice({ text: `${ids.length === 1 ? "Game" : `${ids.length} games`} queued for import.`, kind: "info" });
    } catch (error) { showError(error); }
    finally { setQueueingImport(false); }
  };
  const changeTab = (next: "installed" | "downloaded" | "download" | "epic" | "gog" | "itch" | "google-play") => {
    setTab(next); setQuery(""); setPlatformFilters(allExternalPlatforms());
    if (next === "epic" || next === "gog" || next === "itch" || next === "google-play") setVisitedStores(current => new Set([...current, next]));
  };
  const loadVersions = async (game: SteamLibraryGame, refresh = false) => {
    const generation = ++versionsGeneration.current;
    setSelectedApp(game); setVersions(null); setVersionsError(""); setVersionsLoading(true);
    try { const result = await api.steamVersions(game.appId, refresh); if (generation === versionsGeneration.current) setVersions(normalizeSteamVersions(result)); }
    catch (error) { if (generation === versionsGeneration.current) setVersionsError(errorMessage(error)); }
    finally { if (generation === versionsGeneration.current) setVersionsLoading(false); }
  };
  const connect = async (event: React.FormEvent) => {
    event.preventDefault(); setAuthBusy(true); setNotice(null);
    try {
      await api.steamConnect(signInMode === "client" ? { mode: "client" } : { mode: "manual", accountName: accountName.trim(), ...(password ? { password } : {}), remember });
      setPassword(""); setAddingAccount(false);
    }
    catch (error) { showError(error); }
    finally { setAuthBusy(false); }
  };
  const authenticate = async (event: React.FormEvent) => {
    event.preventDefault(); setAuthBusy(true);
    try { await api.steamAuth({ code: authCode.trim() }); setAuthCode(""); }
    catch (error) { showError(error); }
    finally { setAuthBusy(false); }
  };
  const connectQr = async () => {
    setAuthBusy(true); setNotice(null); setPassword("");
    try {
      await api.steamConnect({ mode: "manual", accountName: accountName.trim(), authMethod: "qr", remember });
      setAddingAccount(false);
    } catch (error) { showError(error); }
    finally { setAuthBusy(false); }
  };
  const visibleLibrary = useMemo(() => sortExternalGames(snapshot.library.filter(game => gameMatches(game, query) &&
    (game.platforms.some(platform => platformFilters.has(platform)) || !game.platforms.length && platformFilters.size === allExternalPlatforms().size) &&
    (accessFilter === "all" || (accessFilter === "shared" ? game.shared : !game.shared)) && (!nativeMacOnly || game.nativeAppleSilicon)), librarySort), [snapshot.library, query, platformFilters, accessFilter, nativeMacOnly, librarySort]);
  const activeImports = (snapshot.imports || []).filter(job => isActive(job.status));
  const failedImports = (snapshot.imports || []).filter(job => job.status === "error");
  const activeAccount = snapshot.accounts?.find(account => account.id === snapshot.activeAccountId);
  const showLogin = (!connected || addingAccount) && !guarding;
  const localFiltered = Boolean(query || platformFilters.size !== allExternalPlatforms().size || importFilters.size !== 2 || storeFilters.size !== Object.keys(storeNames).length || cpuFilters.size !== 3);

  return <main className="launcherView steamView" aria-labelledby="steam-title">
    <header className="launcherViewHeader">
      <h1 className="launcherViewTitle steamViewTitle" id="steam-title"><ExternalMark />External</h1>
      <div className="steamConnection" hidden={tab !== "download"}><span className={`steamDot ${connected ? "connected" : ""}`} />
        {snapshot.accounts?.length ? <select className="input steamAccountSelect" aria-label="Steam account" value={snapshot.activeAccountId || ""}
          onChange={event => {
            const account = snapshot.accounts?.find(item => item.id === event.target.value);
            setAddingAccount(false); setPassword("");
            if (account) { setSignInMode(account.mode); setAccountName(account.mode === "manual" ? account.accountName : ""); }
            void api.steamSelectAccount(event.target.value).catch(showError);
          }}>
          {!snapshot.activeAccountId && <option value="" disabled>Select an account</option>}
          {snapshot.accounts.map(account => <option key={account.id} value={account.id}>{account.mode === "client" ? `Steam for Mac${account.accountName ? ` · ${account.accountName}` : ""}` : `${account.accountName} · Manual sign-in`}</option>)}
        </select> : <span>{connected ? snapshot.connection.accountName || "Connected" : connecting ? "Connecting…" : "Local library"}</span>}
        <button className="btn small" onClick={() => {
          accountHintInitialized.current = true; setAddingAccount(true); setSignInMode("manual"); setAccountName(""); setPassword(""); setTab("download");
        }}>Add account</button>
        {activeAccount?.mode === "manual" && <button className="btn small" onClick={() => { void api.steamRemoveAccount(activeAccount.id).catch(showError); }}>Remove account</button>}
        {(connecting || snapshot.connection.status === "guard") && <button className="btn small" onClick={() => { void api.steamDisconnect().catch(showError); }}>Cancel</button>}
      </div>
      {browsingDownloads && <button className="btn small" onClick={() => { void api.externalOpenDownloads().catch(showError); }}>Open downloads in Finder</button>}
    </header>
    <ScrollableTabStrip label="External libraries" selectedTabId={`steam-${tab}-tab`} tabsClassName="steamTabs" className="externalTabStrip">
      {(["installed", "downloaded", "download", "epic", "gog", "itch", "google-play"] as const).map((name, index, names) => <button key={name} ref={element => { tabRefs.current[index] = element; }}
        id={`steam-${name}-tab`} role="tab" aria-selected={tab === name} aria-controls={`steam-${name}-panel`}
        tabIndex={tab === name ? 0 : -1} className="steamTab" onClick={() => changeTab(name)}
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? names.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + names.length) % names.length;
          changeTab(names[next]); tabRefs.current[next]?.focus();
        }}>{name === "installed" ? "Installed" : name === "downloaded" ? "Downloaded" : name === "download" ? "Steam" : name === "google-play" ? "Android" : storeNames[name]}{(name === "installed" || name === "downloaded") && (name === "installed" ? installed.length : downloaded.length) > 0 && <span className="steamTabCount">{name === "installed" ? installed.length : downloaded.length}</span>}</button>)}
    </ScrollableTabStrip>
    {notice && <Notice text={notice.text} kind={notice.kind} onDismiss={() => setNotice(null)} />}
    <section className="steamPanel" hidden={tab !== "installed" && tab !== "downloaded"} id={`steam-${browsingDownloads ? "downloaded" : "installed"}-panel`} role="tabpanel" aria-labelledby={`steam-${browsingDownloads ? "downloaded" : "installed"}-tab`}>
      <div className="steamToolbar">
        <LibrarySearch query={tab === "installed" || browsingDownloads ? query : ""} onQueryChange={setQuery} />
        <PlatformTagFilter selected={platformFilters} onChange={setPlatformFilters} includeWeb includeAndroid counts={localPlatformCounts} />
        <details className="externalFilters"><summary className="btn small">Filters{storeFilters.size !== Object.keys(storeNames).length || importFilters.size !== 2 ? " •" : ""}</summary><div className="externalFiltersPanel">
          <TagCheckboxFilter label="Filter stores" selected={storeFilters} onChange={setStoreFilters} options={Object.entries(storeNames).map(([id, label]) => ({ id, label }))} />
          <TagCheckboxFilter label="Filter imported games" selected={importFilters} onChange={setImportFilters} options={[{ id: "new", label: "Not imported" }, { id: "imported", label: "Imported" }]} />
          <TagCheckboxFilter label="Filter architecture" selected={cpuFilters} onChange={setCpuFilters} options={[{ id: "arm64", label: "Apple Silicon" }, { id: "x86", label: "Intel / x86" }, { id: "unknown", label: "Not specified" }]} />
        </div></details>
        <LibrarySortSelect value={localSort} onChange={setLocalSort} label={browsingDownloads ? "Sort downloaded copies" : "Sort installed games"} version local />
        {localFiltered && <button className="btn small" onClick={() => { setQuery(""); setPlatformFilters(allExternalPlatforms()); setStoreFilters(new Set(Object.keys(storeNames))); setImportFilters(new Set(["new", "imported"])); setCpuFilters(new Set(["arm64", "x86", "unknown"])); }}>Clear filters</button>}
        <span className="steamToolbarSpacer" /><HelpTip label={browsingDownloads ? "About downloaded copies" : "About installed games"}><p>{browsingDownloads ? "Independent copies of selected game versions. Each copy keeps its selected version and is never updated automatically." : "Installed games from Steam, Epic, GOG, itch.io and local game managers, including CrossOver bottles. Scanning stays offline."}</p></HelpTip>
        <button className="btn small iconOnly" disabled={localScanning} aria-label={browsingDownloads ? "Reload downloaded copies" : "Rescan installed games"} title={browsingDownloads ? "Reload downloaded copies" : "Rescan installed games"} onClick={() => { void (browsingDownloads ? scanDownloaded() : scan()); }}><RefreshIcon /></button>
      </div>
      <div className="steamTableScroll">
        <table className="steamTable" aria-label={browsingDownloads ? "Downloaded game copies" : "Installed external games"} aria-busy={localScanning}>
          <thead><tr><th className="steamCheckColumn"><input ref={selectAllRef} type="checkbox" aria-label="Select all visible games" disabled={!selectable.length}
            checked={selectable.length > 0 && visibleChecked === selectable.length} onChange={event => {
              const checked = event.target.checked; setSelected(current => { const next = new Set(current); for (const id of selectable) { if (checked) next.add(id); else next.delete(id); } return next; });
            }} /></th><th>Game</th><th className="steamStoreColumn">Store</th><th className="steamPlatformColumn">Platform</th><th className="steamInstalledVersionColumn">Version</th><th className="steamPathColumn">Location</th><th className="steamStatusColumn">Library</th></tr></thead>
          <tbody>{visibleInstalled.map(game => <tr key={game.id} className="steamInstalledRow" data-selected={selected.has(game.id)} tabIndex={game.imported ? -1 : 0}
            aria-selected={selected.has(game.id)} onClick={event => { if (!game.imported) selectGame(game.id, event.shiftKey); }}
            onKeyDown={event => { if (event.target === event.currentTarget && [" ", "Enter"].includes(event.key) && !game.imported) { event.preventDefault(); selectGame(game.id, event.shiftKey); } }}>
            <td><input type="checkbox" aria-label={`Select ${game.name}`} disabled={game.imported} checked={selected.has(game.id)} onChange={() => {}}
              onClick={event => { event.stopPropagation(); selectGame(game.id, event.shiftKey); }} /></td>
            <td><div className="steamGameIdentity"><SteamGameIcon name={game.name} url={game.iconUrl && !/^https?:/i.test(game.iconUrl) ? game.iconUrl : null} />
              <span className="steamGameIdentityText"><span className="steamGameName" title={game.name}>{game.name}</span>{browsingDownloads && <span className="steamGameMeta"><span className="steamBadge pinned" title="This copy keeps its selected version and is never updated automatically.">Pinned copy</span></span>}</span></div></td>
            <td><span className={`steamBadge store-${game.store || "steam"}`}>{storeNames[game.store || "steam"]}</span></td>
            <td><PlatformBadge platform={game.platform} inferred={game.platformSource === "client"} />{game.architectureLabel && <span className="steamArchitectureLabel" title={game.architectureLabel}>{game.architectures?.includes("universal") ? "Universal" : game.architectureLabel}</span>}</td>
            <td className="steamInstalledVersion" title={[...new Set([installedVersion(game), game.branch ? `Branch ${game.branch}` : "", game.buildId ? `Build ${game.buildId}` : ""].filter(Boolean))].join(" · ")}>{installedVersion(game, browsingDownloads)}</td>
            <td className="steamPath steamPathColumn" title={game.path}>{libraryLocationLabel({ bottle: game.bottle, sourceLabel: sourceNames[game.source], storeLabel: storeNames[game.store || "steam"], managed: game.source === "managed" })}</td>
            <td>{game.imported ? <span className="steamBadge imported">Imported</span> : <span className="steamGameMeta">—</span>}</td>
          </tr>)}</tbody>
        </table>
        {!visibleInstalled.length && <Empty title={localScanning ? "Loading games…" : localGames.length ? "No matching games" : browsingDownloads ? "No downloaded copies" : "No installed games found"}>
          {localScanning ? "Reading local game records." : localGames.length ? "Change the search or filters to show more games." : browsingDownloads ? "Completed game downloads appear here, including copies saved to a custom folder." : "Local Steam, Epic, GOG, itch.io and CrossOver installation records are scanned automatically. Use Rescan after installing a game."}
        </Empty>}
      </div>
      {failedImports.length > 0 && <Notice text={failedImports.map(job => `${job.name}: ${job.error || "Import failed"}`).join(" · ")} />}
      <footer className="steamSelectionBar"><div><span>{selected.size ? `${selected.size} selected` : `${visibleInstalled.length}${visibleInstalled.length !== localGames.length ? ` of ${localGames.length}` : ""} ${browsingDownloads ? visibleInstalled.length === 1 ? "copy" : "copies" : visibleInstalled.length === 1 ? "game" : "games"}`}</span>
        {activeImports.length > 0 && <div className="steamSelectionHint">{activeImports.length} {activeImports.length === 1 ? "import" : "imports"} in progress…</div>}</div>
        <HelpTip label="About game selection"><p>Shift-click selects a range. Imported games stay in their original location. Selection is kept when filters change.</p></HelpTip>
        <div className="steamSelectionActions">{selected.size > 0 && <button className="btn small" onClick={() => setSelected(new Set())}>Clear selection</button>}
          <button className="btn primary" disabled={!selected.size || queueingImport} onClick={() => { void importGames(); }}>{queueingImport ? "Queueing…" : `Import${selected.size ? ` ${selected.size === 1 ? "game" : `${selected.size} games`}` : ""}`}</button></div>
      </footer>
    </section>
    <section hidden id={`steam-${browsingDownloads ? "installed" : "downloaded"}-panel`} role="tabpanel" aria-labelledby={`steam-${browsingDownloads ? "installed" : "downloaded"}-tab`} />
    <section className="steamPanel" hidden={tab !== "download"} id="steam-download-panel" role="tabpanel" aria-labelledby="steam-download-tab">
      {showLogin && <div className="steamLogin">
        <div className="steamLoginIntro"><SteamMark size={42} /><h2>Connect Steam</h2><HelpTip label="About Steam downloads">
          <p>Download Mac, Windows and Linux game files, including older Mac builds. Choose a branch, language and depot before downloading.</p><p>Connect to load owned and shared games. Library and version results are cached.</p></HelpTip>
        </div>
        <form className="steamLoginForm" onSubmit={connect}>
          <fieldset className="steamSignInModes" disabled={connecting || guarding || authBusy}><legend>Connection <HelpTip label="About Steam sign-in"><p>Reuse the account signed in to the Steam app for Mac. Keep Steam open while loading the library and downloading game files.</p><p>Manual sign-in supports Steam Guard email, authenticator and mobile approval. Passwords are used for sign-in and are not saved.</p></HelpTip></legend>
            <label><input type="radio" name="steam-sign-in-mode" value="client" checked={signInMode === "client"} onChange={() => setSignInMode("client")} /><span>Reuse Steam</span></label>
            <label><input type="radio" name="steam-sign-in-mode" value="manual" checked={signInMode === "manual"} onChange={() => setSignInMode("manual")} /><span>Sign in manually</span></label>
          </fieldset>
          {signInMode === "manual" && <>
            <label className="steamField">Steam account<input className="input" autoComplete="username" value={accountName} onChange={event => setAccountName(event.target.value)} required disabled={connecting || guarding || authBusy} /></label>
            <label className="steamField">Password<input className="input" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} disabled={connecting || guarding || authBusy} placeholder="Use saved sign-in, or enter a password" /></label>
            <label className="steamInlineCheck"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />Remember this sign-in</label>
            <button className="btn" type="button" disabled={connecting || guarding || authBusy || !accountName.trim()} onClick={() => { void connectQr(); }}>Sign in with QR code</button>
          </>}
          <button className="btn primary" type="submit" disabled={connecting || guarding || authBusy || (signInMode === "manual" && !accountName.trim())}>{guarding ? "Waiting for Steam Guard…" : connecting || authBusy ? "Connecting…" : "Connect Steam"}</button>
          {addingAccount && connected && <button className="btn" type="button" onClick={() => { setAddingAccount(false); setPassword(""); }}>Cancel</button>}
        </form>
      </div>}
      {snapshot.connection.error && <Notice text={snapshot.connection.error} />}
      {snapshot.connection.sessionError && <Notice text={snapshot.connection.sessionError} />}
      {guarding && <SteamGuardChallenge guard={snapshot.connection.guard} authCode={authCode} onCodeChange={setAuthCode} busy={authBusy} onSubmit={authenticate} />}
      {connected && !addingAccount && <>
        <div className="steamToolbar"><LibrarySearch query={tab === "download" ? query : ""} onQueryChange={setQuery} /><PlatformTagFilter selected={platformFilters} onChange={setPlatformFilters} includeAndroid />
          <select className="input" aria-label="Filter Steam library access" value={accessFilter} onChange={event => setAccessFilter(event.target.value)}><option value="all">All access</option><option value="owned">Owned only</option><option value="shared">Shared only</option></select>
          <LibrarySortSelect value={librarySort} onChange={setLibrarySort} label="Sort Steam library" access />
          {snapshot.library.some(game => game.nativeAppleSilicon) && <label className={`externalPlatformFilter ${nativeMacOnly ? "checked" : ""}`}><input type="checkbox" aria-label="Filter Steam Apple Silicon games" checked={nativeMacOnly} onChange={event => setNativeMacOnly(event.target.checked)} /><span>Apple Silicon</span></label>}
          <span className="steamCount">{visibleLibrary.length} / {snapshot.library.length}</span>
          {(query || platformFilters.size !== allExternalPlatforms().size || accessFilter !== "all" || nativeMacOnly) && <button className="btn small" onClick={() => { setQuery(""); setPlatformFilters(allExternalPlatforms()); setAccessFilter("all"); setNativeMacOnly(false); }}>Clear filters</button>}<span className="steamToolbarSpacer" />
          {snapshot.cancellationNotice && <HelpTip label="About Steam download cancellation"><p>{snapshot.cancellationNotice}</p></HelpTip>}
          <button className="btn small iconOnly" disabled={snapshot.libraryLoading} aria-label="Reload Steam library" title="Reload Steam library" onClick={() => { void api.steamLibrary(true).catch(showError); }}><RefreshIcon /></button>
        </div>
        {snapshot.libraryError && <Notice text={snapshot.libraryError} />}
        <div className="steamDownloadWorkspace"><div className="steamLibraryPane"><div className="steamTableScroll">
          <table className="steamTable" aria-label="Steam account library" aria-busy={snapshot.libraryLoading}><thead><tr><th>Game</th><th className="steamPlatformColumn">Platforms</th><th className="steamAccessColumn">Access</th></tr></thead>
            <tbody>{visibleLibrary.map(game => <tr key={game.appId} data-selected={selectedApp?.appId === game.appId}>
              <td><button className="steamLibraryButton" aria-pressed={selectedApp?.appId === game.appId} onClick={() => { void loadVersions(game); }}><span className="steamGameIdentity"><SteamGameIcon name={game.name} url={game.iconUrl} />
                <span className="steamGameIdentityText"><span className="steamGameName" title={game.name}>{game.name}</span><span className="steamGameMeta">{game.appId}{game.nativeAppleSilicon && <span className="steamNativeBadge">Apple Silicon</span>}</span></span></span></button></td>
              <td className="steamPlatformColumn"><span className="steamBadges">{game.platforms.map(os => <PlatformBadge key={os} platform={os} />)}</span></td>
              <td>{game.shared ? <span className="steamBadge family">Family sharing</span> : <span className="steamGameMeta">Owned</span>}</td>
            </tr>)}</tbody></table>
          {!visibleLibrary.length && <Empty title={snapshot.libraryLoading ? "Loading Steam library…" : query || platformFilters.size !== allExternalPlatforms().size || accessFilter !== "all" ? "No matching games" : "No games in the cached library"}>
            {snapshot.libraryLoading ? "Loading account licenses and shared games." : "Change the filters or use Reload to load the library."}
          </Empty>}
        </div></div>
          <aside className="steamVersionPane" aria-label="Steam download options">
            {selectedApp ? <><div className="steamVersionIdentity"><SteamGameIcon name={selectedApp.name} url={selectedApp.iconUrl} /><div><h2>{selectedApp.name}</h2><span className="steamGameMeta">Steam App {selectedApp.appId}</span></div></div>
              {versionsLoading ? <Empty title="Loading versions…">Reading branches and depot manifests from Steam.</Empty> : versionsError ? <><Notice text={versionsError} /><div className="steamVersionScroll"><button className="btn" onClick={() => { void loadVersions(selectedApp, true); }}>Retry</button></div></> :
                versions && <SteamVersionOptions key={selectedApp.appId} api={api} game={selectedApp} versions={versions} downloadRoot={snapshot.defaultDirectory} onError={showError}
                  onQueued={() => setNotice({ text: "Download queued.", kind: "success" })} onRefresh={() => { void loadVersions(selectedApp, true); }} />}
            </> : <Empty title="Choose a game">Select a game to view its platforms, branches and downloadable files.</Empty>}
          </aside>
        </div>
      </>}
    </section>
    {(["epic", "gog", "itch", "google-play"] as const).map(store => <section key={store} className="steamPanel" hidden={tab !== store} id={`steam-${store}-panel`} role="tabpanel" aria-labelledby={`steam-${store}-tab`}>
      {visitedStores.has(store) && <ExternalStoreView store={store} api={api} onImported={refreshLocal} active={tab === store} />}
    </section>)}
    {(tab === "installed" || tab === "download") && snapshot.downloads.length > 0 && <DownloadQueue jobs={snapshot.downloads} imports={snapshot.imports || []} api={api} onError={showError} />}
  </main>;
}

function SteamGuardChallenge({ guard, authCode, onCodeChange, busy, onSubmit }: {
  guard?: SteamGuard; authCode: string; onCodeChange: (value: string) => void; busy: boolean; onSubmit: (event: React.FormEvent) => void;
}) {
  const codeOnly = !guard || guard.kind === "email" || guard.kind === "totp";
  const acceptsCode = codeOnly || Boolean(guard?.codeKinds?.length);
  const description = guard?.message || (guard?.kind === "email" ? `Enter the Steam Guard code sent by email${guard.domain ? ` to ${guard.domain}` : ""}.` :
    guard?.kind === "email-approval" ? "Open the Steam sign-in email and approve the request." : guard?.kind === "qr" ? "Scan this code in the Steam mobile app and approve the sign-in." :
      guard?.kind === "mobile" ? "Approve the sign-in in the Steam mobile app." : "Enter a Steam Guard code from the Steam mobile authenticator.");
  const form = <form onSubmit={onSubmit}><label className="steamField">Steam Guard code<input className="input" value={authCode} onChange={event => onCodeChange(event.target.value)} autoComplete="one-time-code" autoFocus={codeOnly} /></label>
    <button className="btn primary" type="submit" disabled={!authCode.trim() || busy}>{busy ? "Verifying…" : "Verify code"}</button></form>;
  return <div className="steamGuard" aria-live="polite"><p>{description}</p>
    {(guard?.error || guard?.lastCodeWrong) && <p className="steamGuardError" role="alert">{guard.error || "The previous code was not accepted. Enter a new Steam Guard code."}</p>}
    {guard?.kind === "qr" && (guard.qrImageUrl?.startsWith("data:image/") ? <img className="steamQrImage" src={guard.qrImageUrl} alt="Steam sign-in QR code" /> : <p>Preparing the sign-in QR code…</p>)}
    {!codeOnly && <p role="status"><span className="steamLoadingDot" />{guard?.remoteInteraction ? "Confirmation received. Finishing sign-in…" : "Waiting for approval…"}</p>}
    {acceptsCode && (codeOnly ? form : <details className="steamHistory"><summary>Enter a code instead</summary>{form}</details>)}
  </div>;
}

export function depotMatchesArchitecture(depot: SteamDepot, architecture: string) {
  if (architecture === "all") return true;
  const evidence = depot.architectures || [];
  if (architecture === "unspecified") return !evidence.length;
  if (!evidence.length) return true;
  const bits = depot.architectureBits || evidence.filter(value => value === "32" || value === "64");
  const cpu = depot.architectureCpu || evidence.filter(value => value === "arm64" || value === "universal");
  if (architecture === "arm64") return cpu.length ? cpu.includes("arm64") || cpu.includes("universal") : bits.includes("64");
  if (architecture === "universal") return cpu.length ? cpu.includes("universal") : bits.includes("64");
  if (architecture === "64") return bits.includes("64") || cpu.includes("arm64") || cpu.includes("x86_64") || cpu.includes("universal");
  return architecture === "32" ? bits.includes("32") : evidence.includes(architecture);
}
const architectureNames: Record<string, string> = { all: "All available", "32": "32-bit", "64": "64-bit (CPU not specified)", arm64: "Apple Silicon", universal: "Universal", unspecified: "Not specified" };

function SteamVersionOptions({ api, game, versions, downloadRoot, onError, onQueued, onRefresh }: {
  api: SteamApi; game: SteamLibraryGame; versions: SteamVersions; downloadRoot?: string;
  onError: (error: unknown) => void; onQueued: () => void; onRefresh: () => void;
}) {
  const platforms = versions.platforms.length ? versions.platforms : ["windows", "macos", "linux", "android"] as SteamPlatform[];
  const [platform, setPlatform] = useState<SteamPlatform>(platforms.includes("windows") ? "windows" : platforms[0]);
  const [branch, setBranch] = useState(versions.branches.some(item => item.id === "public") ? "public" : versions.branches[0]?.id || "public");
  const [architecture, setArchitecture] = useState("all");
  const [language, setLanguage] = useState("english");
  const [branchPassword, setBranchPassword] = useState("");
  const [uncheckedDepots, setUncheckedDepots] = useState<Set<string>>(new Set());
  const [manifestOverrides, setManifestOverrides] = useState<Record<string, string>>({});
  const [extraDepot, setExtraDepot] = useState("");
  const [extraManifest, setExtraManifest] = useState("");
  const [autoImport, setAutoImport] = useState(true);
  const [destination, setDestination] = useState<string | undefined>();
  const [queueing, setQueueing] = useState(false);
  const [depotQuery, setDepotQuery] = useState("");
  const [depotSort, setDepotSort] = useState("name");
  const [depotFilter, setDepotFilter] = useState("all");
  const [historyQuery, setHistoryQuery] = useState("");
  const [historySort, setHistorySort] = useState("date");
  const [historyResult, setHistoryResult] = useState<SteamHistoryResult | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [versionQuery, setVersionQuery] = useState("");
  const [versionSort, setVersionSort] = useState("name");
  const historyCache = useRef(new Map<string, SteamHistoryResult>());
  const languages = [...new Set(versions.depots.flatMap(depot => depot.languages))].sort();
  const branchInfo = versions.branches.find(item => item.id === branch);
  const visibleBranches = filterGameVersions(versions.branches, branch, versionQuery, versionSort);
  const architectureOptions = [...new Set(versions.architectures?.[platform] || versions.depots.filter(depot => !depot.platforms.length || depot.platforms.includes(platform)).flatMap(depot => depot.architectures))];
  if (!architectureOptions.length) architectureOptions.push("unspecified");
  const activeArchitecture = architecture === "all" || architectureOptions.includes(architecture) ? architecture : "all";
  const matchingDepots = versions.depots.filter(depot => (!depot.platforms.length || depot.platforms.includes(platform)) &&
    depotMatchesArchitecture(depot, activeArchitecture) && (!depot.languages.length || depot.languages.includes(language)) && (depot.manifests[branch] || depot.encryptedBranches.includes(branch)));
  const selectedDepots = matchingDepots.filter(depot => !uncheckedDepots.has(depot.id));
  const visibleDepots = matchingDepots.filter(depot => `${depot.name} ${depot.id}`.toLocaleLowerCase().includes(depotQuery.toLocaleLowerCase()) &&
    (depotFilter === "all" || (depotFilter === "selected" ? !uncheckedDepots.has(depot.id) : uncheckedDepots.has(depot.id)))).sort((a, b) =>
      depotSort === "size" ? Number(b.manifests[branch]?.size || 0) - Number(a.manifests[branch]?.size || 0) :
        (depotSort === "id" ? a.id.localeCompare(b.id, undefined, { numeric: true }) : a.name.localeCompare(b.name)));
  const history = [...new Map([...versions.history, ...(historyResult?.history || [])].map(item => [`${item.depotId}:${item.manifestId}`, item])).values()];
  const visibleHistory = history.filter(item => selectedDepots.some(depot => depot.id === item.depotId) && `${item.depotId} ${item.manifestId} ${item.branch || ""} ${item.date || item.observedAt || ""}`.toLocaleLowerCase().includes(historyQuery.toLocaleLowerCase())).sort((a, b) =>
    historySort === "manifest" ? b.manifestId.localeCompare(a.manifestId, undefined, { numeric: true }) : historySort === "depot" ? a.depotId.localeCompare(b.depotId, undefined, { numeric: true }) : (b.date || b.observedAt || "").localeCompare(a.date || a.observedAt || ""));
  const fetchHistory = async (refresh = false) => {
    const ids = selectedDepots.map(depot => depot.id).sort();
    const key = ids.join(",");
    if (!ids.length) { setHistoryError("Select game files before fetching previous versions."); return; }
    if (!refresh && historyCache.current.has(key)) { setHistoryResult(historyCache.current.get(key)!); setHistoryError(""); return; }
    setHistoryBusy(true); setHistoryError("");
    try { const result = await api.steamPreviousVersions(game.appId, ids, refresh); historyCache.current.set(key, result); setHistoryResult(result); }
    catch (error) { setHistoryError(errorMessage(error)); }
    finally { setHistoryBusy(false); }
  };
  const totalSize = selectedDepots.reduce((total, depot) => total + Number(depot.manifests[branch]?.size || 0), 0);
  const invalidManifest = Object.entries(manifestOverrides).some(([id, value]) => value.trim() && selectedDepots.some(depot => depot.id === id) && !/^\d+$/.test(value.trim()));
  const extraValid = (!extraDepot && !extraManifest) || (/^\d+$/.test(extraDepot) && /^\d+$/.test(extraManifest));
  const canDownload = (selectedDepots.length > 0 || Boolean(extraDepot && extraManifest)) && !invalidManifest && extraValid && (!branchInfo?.passwordRequired || Boolean(branchPassword));
  const queueDownload = async () => {
    setQueueing(true);
    try {
      const depots = selectedDepots.map(depot => ({ depotId: depot.id, ...(manifestOverrides[depot.id]?.trim() ? { manifestId: manifestOverrides[depot.id].trim() } : {}) }));
      if (extraDepot && extraManifest) { const existing = depots.find(depot => depot.depotId === extraDepot); if (existing) existing.manifestId = extraManifest; else depots.push({ depotId: extraDepot, manifestId: extraManifest }); }
      await api.steamDownload({ appId: game.appId, name: game.name, platform, branch, architecture: activeArchitecture, language, depots, autoImport, ...(destination ? { destination } : {}), ...(branchPassword ? { branchPassword } : {}) });
      onQueued();
    } catch (error) { onError(error); }
    finally { setQueueing(false); }
  };
  return <><div className="steamVersionScroll">
    <section className="steamVersionSection"><h3 className="steamVersionSectionTitle externalControlHelp">Game version <HelpTip label="About Steam game versions"><p>{branchInfo?.description || "Choose a branch and build. Steam account access determines available versions and files."}</p></HelpTip></h3>
      <div className="steamFieldGrid"><label className="steamField full">Version / branch<select className="input" aria-label="Steam download version" value={branch} onChange={event => { setBranch(event.target.value); setManifestOverrides({}); }}>{versions.branches.length ? visibleBranches.map(item => <option key={item.id} value={item.id}>{gameVersionLabel(item)}{item.id === "public" ? " (default)" : ""}{item.passwordRequired ? " · password required" : ""}</option>) : <option value="public">public (default)</option>}</select></label>
        <div className="steamField full"><VersionFilterTools query={versionQuery} onQueryChange={setVersionQuery} sort={versionSort} onSortChange={setVersionSort} /></div>
        <label className="steamField">Platform<select className="input" aria-label="Steam download platform" value={platform} onChange={event => { setPlatform(event.target.value as SteamPlatform); setArchitecture("all"); }}>{platforms.map(os => <option key={os} value={os}>{platformNames[os]}</option>)}</select></label>
        <label className="steamField"><span className="externalControlHelp">Architecture <HelpTip label="About game architecture"><p>{versions.architectureNotes?.[platform] || "Choices use architecture information supplied by Steam. Shared files can be used by more than one architecture."}</p></HelpTip></span><select className="input" aria-label="Steam download architecture" value={activeArchitecture} onChange={event => setArchitecture(event.target.value)}>{["all", ...architectureOptions].map(value => <option key={value} value={value}>{versions.architectureLabels?.[platform]?.[value] || architectureNames[value] || value}</option>)}</select></label>
        <label className="steamField full">Language<select className="input" aria-label="Steam download language" value={language} onChange={event => setLanguage(event.target.value)}>{[...new Set(["english", ...languages])].map(item => <option key={item} value={item}>{item.charAt(0).toUpperCase() + item.slice(1)}</option>)}</select></label>
        {branchInfo?.passwordRequired && <label className="steamField full">Branch password<input className="input" type="password" value={branchPassword} onChange={event => setBranchPassword(event.target.value)} autoComplete="off" /></label>}
      </div>
      {branchInfo?.buildId && <p className="steamBranchNote">Build {branchInfo.buildId}</p>}
    </section>
    <section className="steamVersionSection"><h3 className="steamVersionSectionTitle">Game files <span className="steamCount">{selectedDepots.length} selected{totalSize > 0 ? ` · ${formatBytes(totalSize)}` : ""}</span></h3>
      <div className="externalListTools"><input className="input" aria-label="Search Steam depots" placeholder="Search files" value={depotQuery} onChange={event => setDepotQuery(event.target.value)} /><select className="input" aria-label="Sort Steam depots" value={depotSort} onChange={event => setDepotSort(event.target.value)}><option value="name">Name</option><option value="id">Depot ID</option><option value="size">Size</option></select><select className="input" aria-label="Filter Steam depots" value={depotFilter} onChange={event => setDepotFilter(event.target.value)}><option value="all">All files</option><option value="selected">Selected</option><option value="unselected">Unselected</option></select></div>
      <div className="steamDepotList">{visibleDepots.map(depot => <label key={depot.id} className="steamDepot"><input type="checkbox" aria-label={`Select depot ${depot.id}`} checked={!uncheckedDepots.has(depot.id)} onChange={event => {
        const checked = event.target.checked; setUncheckedDepots(current => { const next = new Set(current); if (checked) next.delete(depot.id); else next.add(depot.id); return next; });
      }} /><span><span className="steamDepotName">{depot.name || `Depot ${depot.id}`}</span><span className="steamDepotMeta">{depot.id} · {depot.manifests[branch]?.id ? `Manifest ${depot.manifests[branch].id}` : "Password-protected manifest"}</span></span><span className="steamDepotSize">{formatBytes(depot.manifests[branch]?.size)}</span></label>)}</div>
      {!matchingDepots.length && <p className="steamBranchNote" role="status">No files match the selected platform, architecture, language and branch.</p>}
      {matchingDepots.length > 0 && !visibleDepots.length && <p className="steamBranchNote" role="status">No files match the filters.</p>}
      <details className="steamHistory"><summary>Previous versions and manifest IDs</summary>
        <div className="externalHistoryActions"><button className="btn small" disabled={historyBusy || !selectedDepots.length} onClick={() => { void fetchHistory(); }}>{historyBusy ? "Fetching…" : "Fetch previous versions"}</button>
          <HelpTip label="About previous Steam versions"><p>{versions.historyNote || "Steam lists current branch manifests. Previous versions use a manifest ID for each selected depot. Availability depends on Steam account access."}</p><p>Fetch reads SteamDB for the selected depots. Results are suggestions; choosing or entering a manifest ID changes the download.</p></HelpTip>
          <button className="btn small" onClick={() => { void api.steamOpenHistory(game.appId, selectedDepots[0]?.id).catch(onError); }}>Open SteamDB</button>
          {historyResult && <button className="btn small iconOnly" disabled={historyBusy} aria-label="Reload previous Steam versions" title="Reload previous Steam versions" onClick={() => { void fetchHistory(true); }}><RefreshIcon /></button>}
        </div>
        {historyError && <p className="steamHistoryStatus error" role="alert">{historyError}</p>}
        {historyResult?.message && <p className="steamHistoryStatus" role="status">{historyResult.message}</p>}
        <div className="steamManifestFields">{selectedDepots.map(depot => <label key={depot.id} className="steamField">{depot.name || `Depot ${depot.id}`} · {depot.id}
          <input className="input" inputMode="numeric" value={manifestOverrides[depot.id] || ""} placeholder={depot.manifests[branch]?.id || "Manifest ID"}
            aria-label={`Manifest ID for depot ${depot.id}`} aria-invalid={Boolean(manifestOverrides[depot.id] && !/^\d+$/.test(manifestOverrides[depot.id].trim()))}
            onChange={event => setManifestOverrides(current => ({ ...current, [depot.id]: event.target.value }))} list={`steam-manifests-${depot.id}`} />
          <datalist id={`steam-manifests-${depot.id}`}>{history.filter(item => item.depotId === depot.id).map(item => <option key={item.manifestId} value={item.manifestId}>{[item.branch, item.date || item.observedAt].filter(Boolean).join(" · ") || "Previous manifest"}</option>)}</datalist></label>)}
          <div className="steamFieldGrid"><label className="steamField">Additional depot ID<input className="input" inputMode="numeric" value={extraDepot} onChange={event => setExtraDepot(event.target.value.trim())} placeholder="Depot ID" /></label>
            <label className="steamField">Manifest ID<input className="input" inputMode="numeric" value={extraManifest} onChange={event => setExtraManifest(event.target.value.trim())} placeholder="Manifest ID" /></label></div>
        </div>
        {history.length > 0 && <><div className="externalListTools"><input className="input" aria-label="Search Steam manifest history" placeholder="Search previous manifests" value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} /><select className="input" aria-label="Sort Steam manifest history" value={historySort} onChange={event => setHistorySort(event.target.value)}><option value="date">Newest date</option><option value="manifest">Manifest ID</option><option value="depot">Depot ID</option></select></div>
          <div className="externalManifestHistory">{visibleHistory.map(item => <div className="externalManifestEntry" key={`${item.depotId}:${item.manifestId}`}><span><strong>{item.manifestId}</strong><span className="steamDepotMeta">Depot {item.depotId}{item.branch ? ` · ${item.branch}` : ""}{item.date || item.observedAt ? ` · ${item.date || item.observedAt}` : ""}</span></span><button className="btn small" aria-label={`Use manifest ${item.manifestId} for depot ${item.depotId}`} onClick={() => setManifestOverrides(current => ({ ...current, [item.depotId]: item.manifestId }))}>Use</button></div>)}</div></>}
      </details>
    </section>
    <section className="steamVersionSection"><h3 className="steamVersionSectionTitle externalControlHelp">Download location <HelpTip label="About Steam download locations"><p>A separate folder is created for this version. Changing the folder applies to this download.</p></HelpTip></h3><div className="steamDestination"><div className="steamDestinationPath" title={destination || downloadRoot}>
      {destination || downloadRoot || "MacLauncher Application Support · Steam downloads"}</div><div className="steamDestinationActions"><button className="btn small" onClick={() => { void api.steamChooseDirectory().then(folder => { if (folder) setDestination(folder); }).catch(onError); }}>Choose folder…</button>
      <button className="btn small" onClick={() => { void api.externalOpenDownloads("steam").catch(onError); }}>Open default in Finder</button>
      {destination && <button className="btn small" onClick={() => setDestination(undefined)}>Use managed location</button>}</div></div></section>
    <button className="btn small iconOnly" aria-label="Reload Steam versions" title="Reload Steam versions" onClick={onRefresh}><RefreshIcon /></button>
  </div><div className="steamDownloadActions"><label className="steamInlineCheck"><input type="checkbox" checked={autoImport} onChange={event => setAutoImport(event.target.checked)} />Import into MacLauncher when the download finishes</label>
    <button className="btn primary" disabled={!canDownload || queueing} onClick={() => { void queueDownload(); }}><DownloadIcon />{queueing ? "Queueing…" : `Download${totalSize > 0 ? ` · ${formatBytes(totalSize)}` : ""}`}</button>
  </div></>;
}

function DownloadQueue({ jobs, imports, api, onError }: { jobs: SteamDownload[]; imports: SteamImportJob[]; api: SteamApi; onError: (error: unknown) => void }) {
  const active = jobs.filter(job => isActive(job.status)).length;
  const labels: Record<SteamDownload["status"], string> = { queued: "Queued", preparing: "Preparing", downloading: "Downloading", completed: "Downloaded", cancelled: "Cancelled", error: "Failed" };
  const [importing, setImporting] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useDownloadQueueExpansion();
  const importDownload = async (id: string) => {
    setImporting(current => new Set([...current, id]));
    try { await api.steamImportDownload(id); }
    catch (error) { onError(error); }
    finally { setImporting(current => { const next = new Set(current); next.delete(id); return next; }); }
  };
  return <details className="steamJobs" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>Downloads{active ? ` · ${active} active` : ` · ${jobs.length}`}</summary>
    {[...jobs].reverse().map(job => {
      const pendingImport = importing.has(job.id) || imports.some(task => task.sourceId === job.id && isActive(task.status));
      const importError = job.importError || [...imports].reverse().find(task => task.sourceId === job.id && task.status === "error")?.error;
      return <div className="steamJob" key={job.id}><div className="steamJobTop"><span className="steamJobName">{job.name} <span className="steamJobStatus">· {platformNames[job.platform]} · {job.branch}{job.accountName ? ` · ${job.accountName}` : ""}</span></span>
      <div className="steamJobActions">{job.imported ? <span className="steamBadge imported">Imported</span> : <span className="steamJobStatus">{labels[job.status]}</span>}
        {isActive(job.status) && <button className="btn small" onClick={() => { void api.steamCancel(job.id).catch(onError); }}>Cancel</button>}
        {job.status === "completed" && !job.imported && <button className="btn small" disabled={pendingImport} onClick={() => { void importDownload(job.id); }}>{pendingImport ? "Importing…" : "Import"}</button>}
      </div></div>
      {isActive(job.status) && (job.total > 0 ? <progress aria-label={`Download progress for ${job.name}`} max={job.total} value={job.downloaded} /> : <progress aria-label={`Preparing download for ${job.name}`} />)}
      {job.status === "downloading" && job.total > 0 && <p className="steamJobDetail">{formatBytes(job.downloaded) || "0 B"} of {formatBytes(job.total)} · {Math.min(100, Math.floor(job.downloaded / job.total * 100))}%</p>}
      {(job.error || importError || job.detail || job.status === "completed") && <p className={`steamJobDetail ${job.error || importError ? "error" : ""}`}>{job.error || (importError ? `Downloaded; import failed: ${importError}` : job.detail || job.path)}</p>}
    </div>; })}
  </details>;
}
