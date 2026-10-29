// The External window's stores, each with a demo account. The titles are
// well-known games listed by name only; nothing is fetched.
import type {
  SteamDownload, SteamDownloadSelection, SteamInstalledGame, SteamLibraryGame, SteamSnapshot, SteamVersions
} from "../../../../src/renderer/src/ui/components/SteamView";
import type {
  ExternalLibraryGame, ExternalPlatform, ExternalStore, ExternalStoreSelection, ExternalStoreSnapshot, ExternalStoreVersions
} from "../../../../src/renderer/src/ui/components/ExternalStoreView";

const LIBRARY_DIR = "/Users/Shared/Games/Steam";

const library: SteamLibraryGame[] = [
  { appId: "620", name: "Portal 2", platforms: ["windows", "macos", "linux"], shared: false },
  { appId: "413150", name: "Stardew Valley", platforms: ["windows", "macos", "linux"], shared: false },
  { appId: "367520", name: "Hollow Knight", platforms: ["windows", "macos", "linux"], shared: false },
  { appId: "105600", name: "Terraria", platforms: ["windows", "macos", "linux"], shared: false },
  { appId: "391540", name: "Undertale", platforms: ["windows", "macos", "linux"], shared: false },
  { appId: "1145360", name: "Hades", platforms: ["windows", "macos"], shared: false }
];

const installed: SteamInstalledGame[] = library.slice(1, 4).map(game => ({
  id: `steam:${game.appId}`, appId: game.appId, name: game.name, path: `${LIBRARY_DIR}/${game.name}`,
  gamePath: `${LIBRARY_DIR}/${game.name}`, platform: "windows", platformSource: "manifest", source: "steam", store: "steam",
  libraryPath: LIBRARY_DIR, imported: false, buildId: "1000000"
}));

const example = (appId: string, name: string, platforms: ExternalPlatform[]): ExternalLibraryGame =>
  ({ appId, name, platforms, shared: false, owned: true });
const storeLibraries: Record<ExternalStore, ExternalLibraryGame[]> = {
  gog: [example("witcher-3", "The Witcher 3: Wild Hunt", ["windows"]), example("disco-elysium", "Disco Elysium", ["windows", "macos"])],
  epic: [example("control", "Control", ["windows"]), example("alan-wake-2", "Alan Wake 2", ["windows"])],
  itch: [example("a-short-hike", "A Short Hike", ["windows", "macos", "linux"]), example("baba-is-you", "Baba Is You", ["windows", "macos", "linux"])],
  "google-play": []
};
const androidCatalog = [example("android:stardew", "Stardew Valley", ["android"]), example("android:monument", "Monument Valley", ["android"]),
  example("android:altos-odyssey", "Alto's Odyssey", ["android"])];

export function createExternalStores() {
  let steam: SteamSnapshot = { connection: { status: "disconnected" }, library: [], libraryLoading: false, downloads: [],
    defaultDirectory: LIBRARY_DIR, accounts: [] };
  const stores = new Map<ExternalStore, ExternalStoreSnapshot>();
  const storeState = (store: ExternalStore) => stores.get(store) ||
    { connection: { status: "disconnected" }, library: [], libraryLoading: false, downloads: [], defaultDirectory: `/Users/Shared/Games/${store}` };
  const steamListeners = new Set<(state: SteamSnapshot) => void>();
  const storeListeners = new Set<(event: { store: ExternalStore; state: ExternalStoreSnapshot }) => void>();
  const setStore = (store: ExternalStore, next: ExternalStoreSnapshot) => {
    stores.set(store, next);
    for (const listener of [...storeListeners]) listener({ store, state: next });
    return next;
  };
  const setSteam = (next: SteamSnapshot) => { steam = next; for (const listener of [...steamListeners]) listener(steam); return steam; };

  return {
    steamState: () => steam,
    onSteamState(callback: (state: SteamSnapshot) => void) {
      steamListeners.add(callback);
      return () => { steamListeners.delete(callback); };
    },
    scan: () => installed,
    connect: () => setSteam({ ...steam, connection: { status: "connected", accountName: "demo_player", mode: "client" },
      accounts: [{ id: "demo", accountName: "demo_player", mode: "client", status: "connected" }], activeAccountId: "demo",
      library, libraryFetchedAt: Date.now() }),
    disconnect: () => setSteam({ ...steam, connection: { status: "disconnected" }, library: [], accounts: [] }),
    versions(appId: string): SteamVersions {
      const game = library.find(item => item.appId === appId) || library[0];
      const depot = (id: string, name: string, platform: "windows" | "macos" | "linux") => ({
        id, name, platforms: [platform], architectures: ["64"], languages: ["english"], encryptedBranches: [],
        manifests: { public: { id: `${id}0000000000001`, size: 2_400_000_000, downloadSize: 1_100_000_000 } } });
      return { appId: game.appId, name: game.name, platforms: game.platforms,
        branches: [{ id: "public", name: "public", buildId: "1000000" }, { id: "beta", name: "beta", description: "Public beta", buildId: "1000100" }],
        depots: game.platforms.map((platform, index) => depot(`${Number(game.appId) + index + 1}`, `${game.name} ${platform}`, platform as "windows" | "macos" | "linux")),
        history: [] };
    },
    download(selection: SteamDownloadSelection) {
      const download: SteamDownload = { id: `demo-${selection.appId}-${steam.downloads.length}`, status: "completed",
        name: selection.name, appId: selection.appId, platform: selection.platform, branch: selection.branch,
        path: `${LIBRARY_DIR}/${selection.name}`, downloaded: 1, total: 1, autoImport: selection.autoImport, imported: false };
      setSteam({ ...steam, downloads: [...steam.downloads, download] });
      return true;
    },
    storeState,
    onStoreState(callback: (event: { store: ExternalStore; state: ExternalStoreSnapshot }) => void) {
      storeListeners.add(callback);
      return () => { storeListeners.delete(callback); };
    },
    connectStore: (store: ExternalStore) => setStore(store,
      { ...storeState(store), connection: { status: "connected", accountName: "demo_player" }, library: storeLibraries[store] }),
    disconnectStore: (store: ExternalStore) => setStore(store, { ...storeState(store), connection: { status: "disconnected" }, library: [] }),
    search: (_store: ExternalStore, query: string) =>
      androidCatalog.filter(game => !query.trim() || game.name.toLowerCase().includes(query.trim().toLowerCase())),
    storeVersions(store: ExternalStore, appId: string): ExternalStoreVersions {
      const game = [...storeLibraries[store], ...androidCatalog].find(item => item.appId === appId) || androidCatalog[0];
      return { appId: game.appId, name: game.name, platforms: game.platforms, languages: ["English"], depots: [], history: [],
        branches: [{ id: "latest", name: "Latest", versionName: "1.0", platforms: game.platforms }] };
    },
    storeDownload(store: ExternalStore, selection: ExternalStoreSelection) {
      const state = storeState(store);
      setStore(store, { ...state, downloads: [...state.downloads, { id: `demo-${store}-${selection.appId}-${state.downloads.length}`,
        status: "completed", name: selection.name, appId: selection.appId, platform: selection.platform, branch: selection.branch,
        path: `/Users/Shared/Games/${selection.name}`, downloaded: 1, total: 1, autoImport: selection.autoImport, imported: false }] });
      return true;
    }
  };
}
