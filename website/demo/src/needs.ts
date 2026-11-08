// What the part of the launcher behind each demo action needs, for the
// "What this needs" list beside its articles. Processors, macOS versions,
// stated runtime requirements and how each package is delivered come from
// the launcher's own declarations, which data/generate.cjs records in the
// demo data. The other entries restate requirements from docs/, named in the
// comment above each group.
import { demoData } from "./data";
import type { LauncherState } from "../../../src/renderer/src/ui/types";
import type { DemoTopic } from "./mock/store";

type NeedKind = "mac" | "macos" | "own" | "account" | "download" | "inputs" | "permission" | "note";
export type Need = { kind: NeedKind; text: string };
export const NEED_LABELS: Record<NeedKind, string> = { mac: "Mac", macos: "macOS", own: "You provide", account: "Account",
  download: "Download", inputs: "From the game", permission: "Permission", note: "Also" };

type Feature = { label: string; macOS?: string; appleSilicon?: boolean };
type Requirements = {
  launcher: { macOS: string };
  features: Record<string, Feature>;
  runtimes: Record<string, { label: string; manager?: string; feature?: Feature; text?: string }>;
  managers: Record<string, { label: string; delivery?: string; included?: boolean; feature?: Feature }>;
  methods: Record<string, Feature>;
};
type CatalogRow = { id: string; kind: string; inputContract?: { requires?: string[] }; requirements?: string[];
  modelSource?: { label: string; bytes?: number }; runtimeManagerId?: string; template?: { method?: string; shader?: { preset?: string } } };

const data = demoData as unknown as { requirements: Requirements; graphics: { hosts: Record<string, { info: { catalog: CatalogRow[] } }> } };
const requirements = data.requirements;
const launcherMacOS = requirements.launcher.macOS;

const need = (kind: NeedKind, text: string): Need => ({ kind, text });
const parts = (version: string) => version.split(".").map(Number);
function newer(version: string) {
  const [a, b] = [parts(version), parts(launcherMacOS)];
  for (let index = 0; index < Math.max(a.length, b.length); index++) if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  return false;
}
const macOS = (version: string) => newer(version) ? [need("macos", `${version.replace(/(\.0)+$/, "")} or later`)] : [];
const featureNeeds = (feature?: Feature): Need[] => feature ? [...(feature.appleSilicon ? [need("mac", "Apple Silicon")] : []),
  ...(feature.macOS ? macOS(feature.macOS) : [])] : [];

// A runtime's own requirement line, such as "Apple Silicon · macOS 26.0 or
// later · 1.95 GB system image", part by part.
function statedNeeds(text = ""): Need[] {
  return text.split(" · ").filter(Boolean).flatMap(part => {
    if (/^Apple Silicon$/i.test(part)) return [need("mac", "Apple Silicon")];
    const version = /^macOS (\d+(?:\.\d+)*)(?: or later)?$/i.exec(part)?.[1];
    if (version) return macOS(version);
    if (/^macOS /i.test(part)) return [need("macos", part.replace(/^macOS (\w)/i, (_, letter: string) => letter.toUpperCase()))];
    if (/Rosetta/i.test(part)) return [need("mac", part)];
    if (/\b[\d.]+ ?[GM]B\b/.test(part)) return [need("download", part)];
    return [need("note", part)];
  });
}

const PLAY_DOWNLOAD = "Downloaded after you agree, the first time it's needed. Installed versions work offline.";
function deliveryNeeds(managerId?: string): Need[] {
  const manager = managerId ? requirements.managers[managerId] : undefined;
  if (!manager || manager.delivery === "local" || manager.delivery === "local-files") return [];
  return [need("download", manager.included ? "One version comes with MacLauncher. Others download after you agree." : PLAY_DOWNLOAD)];
}

const KEYS = "A prod.keys file, only for encrypted containers. NUP files and decrypted dumps play without one.";
const LOSSLESS = "Lossless Scaling, bought on Steam. MacLauncher downloads it with your Steam account, finds an installed copy or imports Lossless.dll.";
const STEAM_CLIENT = "The Steam client for Mac, installed. MacLauncher starts it when it isn't running.";
const DOCS: Record<string, Need[]> = {
  // docs/runtimes/CROSSOVER.md, docs/runtimes/SIKARUGIR.md and the CPU notes in
  // docs/runtimes/SYSTEM_REQUIREMENTS.md.
  "runtime:crossover": [need("own", "Your own copy of CrossOver, CodeWeavers' commercial WINE. MacLauncher finds it in Applications and never downloads it."),
    need("mac", "Rosetta on Apple Silicon, unless CrossOver has an ARM64 WINE loader")],
  "runtime:sikarugir": [need("mac", "Rosetta on Apple Silicon, because its WINE is an Intel program")],
  "runtime:hashlink": [need("mac", "Rosetta on Apple Silicon, because HashLink's JIT compiler produces Intel code")],
  // docs/game-types/SWITCH.md, IOS.md, PS5.md, HALF_LIFE.md and ANDROID.md.
  "runtime:nxnative": [need("mac", "Apple Silicon"), need("own", KEYS)],
  "runtime:playcover": [need("own", "An unencrypted .ipa. Encrypted IPAs can't be played.")],
  "runtime:anyps5": [need("own", "An unpacked, decrypted PS5 game. MacLauncher doesn't decrypt PS5 content.")],
  "runtime:prosper": [need("own", "An unpacked, decrypted PS5 game. MacLauncher doesn't decrypt PS5 content.")],
  "runtime:xash3d-fwgs": [need("own", "The original Half-Life game files")],
  "runtime:klepton": [need("download", "The Android 16 system image, and Java 21 when none is installed, after you agree")],
  // docs/game-types/WINDOW.md.
  "runtime:capture": [need("permission", "Screen & System Audio Recording, for previews, displays and choosing a window directly"),
    need("permission", "Accessibility, to fit the screen or enlarge the window")],
  // docs/runtimes/TRANSLATORS.md, KOSMICKRISP.md and WINDOWS_STEAM.md, and the
  // Lossless Scaling and XeSS rows of Runtimes → Graphics.
  "manager:translator-d3dmetal": [need("own", "D3DMetal from a Sikarugir Template or your own Game Porting Toolkit download. MacLauncher neither hosts nor builds it.")],
  "manager:dxvk": [need("note", "Runs on MacLauncher KosmicKrisp, or on MoltenVK scene support on a Mac without Metal 4")],
  "manager:translator-dxvk": [need("note", "Runs on MacLauncher KosmicKrisp, or on MoltenVK scene support on a Mac without Metal 4")],
  "manager:translator-vkd3d-proton": [need("note", "Runs on MacLauncher KosmicKrisp, or on MoltenVK scene support on a Mac without Metal 4")],
  "manager:vulkan-kosmickrisp": [need("note", "MoltenVK serves Intel Macs, macOS versions before 26 and virtual machines")],
  "manager:maclauncher-kosmickrisp": [need("note", "MoltenVK serves Intel Macs, macOS versions before 26 and virtual machines")],
  "manager:maclauncher-steam-bridge": [need("own", STEAM_CLIENT),
    need("note", "A Windows game in CrossOver or Sikarugir that includes steam_api.dll or steam_api64.dll"),
    need("note", "The game's Steam app ID, known from a Steam library on this Mac or a MacLauncher Steam download")],
  "manager:graphics-models": [need("own", LOSSLESS)],
  "manager:graphics-neural-models": [need("download", "Each model downloads after you agree, or can be imported from a file")],
  "manager:graphics-xess": [need("note", "A compatible GPU compute host")],
  // website/src/content/docs/tools/stores-and-downloads.md and the Google Play
  // tab's own help.
  "store:steam": [need("account", "Your Steam account, either the one signed in to Steam on this Mac or one you sign in to here")],
  "store:gog": [need("account", "Your GOG account")], "store:epic": [need("account", "Your Epic Games account")],
  "store:itch": [need("account", "Your itch.io account")],
  "store:google-play": [need("account", "A Google account for Google Play purchases, shared with the Android runtimes"),
    need("note", "F-Droid and IzzyOnDroid search works without Google sign-in"), need("mac", "Apple Silicon, to play the Android apps")]
};
// Features that belong to one runtime or package.
const RUNTIME_FEATURES: Record<string, string> = { capture: "window" };
const MANAGER_FEATURES: Record<string, string> = { "translator-d3dmetal": "d3dmetal", "sikarugir-graphics-bridge": "dxmt" };
const WINE_RUNTIMES = new Set(["crossover", "sikarugir"]);

function runtimeNeeds(runtimeId: string): Need[] {
  const runtime = requirements.runtimes[runtimeId];
  if (!runtime) return [];
  return [...featureNeeds(requirements.features[RUNTIME_FEATURES[runtimeId]]), ...featureNeeds(runtime.feature), ...statedNeeds(runtime.text),
    ...featureNeeds(runtime.manager ? requirements.managers[runtime.manager]?.feature : undefined),
    ...(DOCS[`runtime:${runtimeId}`] || []), ...deliveryNeeds(runtime.manager)];
}

function managerNeeds(managerId: string): Need[] {
  const runtimes = Object.entries(requirements.runtimes).filter(([, runtime]) => runtime.manager === managerId).map(([id]) => id);
  if (runtimes.length) return runtimes.flatMap(runtimeNeeds);
  const manager = requirements.managers[managerId];
  return [...featureNeeds(requirements.features[MANAGER_FEATURES[managerId]]), ...featureNeeds(manager?.feature),
    ...(DOCS[`manager:${managerId}`] || []), ...deliveryNeeds(managerId)];
}

// A translator choice in Runtime Settings names its package before the colon,
// as in "dxvk:3.1.1"; an included choice names its engine last.
function translatorNeeds(value: string): Need[] {
  const managerId = value.split(":")[0];
  if (requirements.managers[managerId]) return managerNeeds(managerId);
  const engine = value.split(":").at(-1) || "";
  return featureNeeds(requirements.features[engine]);
}

const INPUTS: Record<string, string> = { depth: "depth", motion: "motion vectors", camera: "camera data", projectionMatrix: "the projection matrix" };
function sizeText(bytes?: number) {
  if (!bytes) return "";
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
function catalogRow(kind: string, key: string) {
  for (const host of Object.values(data.graphics.hosts)) {
    const row = host.info.catalog.find(item => item.kind === kind &&
      (item.id === `${kind}:${key}` || item.template?.method === key || item.template?.shader?.preset === key || item.id === key));
    if (row) return row;
  }
}
function effectNeeds(kind: string, key: string, moduleId?: string): Need[] {
  const row = catalogRow(kind, key);
  if (!row) return [];
  const requires = row.inputContract?.requires || [];
  const inputs = requires.filter(item => INPUTS[item]).map(item => INPUTS[item]);
  const list = inputs.length > 1 ? `${inputs.slice(0, -1).join(", ")} and ${inputs.at(-1)}` : inputs[0];
  return [...featureNeeds(requirements.methods[row.id]),
    // docs/graphics: temporal upscaling in Windows games has its own platform minimum.
    ...(moduleId === "crossover" && kind === "temporal" ? featureNeeds(requirements.features.wineTemporal) : []),
    ...(list ? [need("inputs", list[0].toUpperCase() + list.slice(1) + ", from the game's renderer")] : []),
    ...(requires.includes("opaque") ? [need("note", "A picture without transparency")] : []),
    ...(row.requirements?.includes("models") ? [need("own", LOSSLESS)] : []),
    ...(row.modelSource ? [need("download", `${row.modelSource.label}${row.modelSource.bytes ? `, ${sizeText(row.modelSource.bytes)}` : ""}, after you agree`)] : []),
    ...(row.runtimeManagerId === "graphics-xess" ? DOCS["manager:graphics-xess"] : [])];
}

function gameNeeds(state: LauncherState, gamePath: string): Need[] {
  const entry = state.recents.find(item => item.gamePath === gamePath);
  if (!entry) return [];
  const list = runtimeNeeds(entry.runtimeId);
  // A decrypted Switch dump needs no keys.
  if (entry.moduleData?.keyRequirement === "none") return [...list.filter(item => item.text !== KEYS), need("note", "No prod.keys for this decrypted dump")];
  return list;
}

const STORE_TOPICS = new Set(["account", "download", "versions", "search"]);
const EFFECT_KINDS = new Set(["upscale", "temporal", "frame-generation", "neural", "shader", "downsample"]);

/**
 * What a topic's subject needs, or null for an action with no subject of its
 * own, such as sorting the library. An empty list means nothing beyond
 * MacLauncher itself.
 */
export function needsFor(topic: DemoTopic, state: LauncherState): Need[] | null {
  const detail = typeof topic.detail === "string" ? topic.detail : "";
  const list = ((): Need[] | null => {
    switch (topic.kind) {
      case "game": return gameNeeds(state, topic.id);
      case "runtime": case "play": case "version": return topic.id ? runtimeNeeds(topic.id) : null;
      case "runtime-settings": {
        if (["arguments", "network", "environment", "module"].includes(topic.id)) return null;
        const change = topic.detail && typeof topic.detail === "object" ? topic.detail as { key?: string; value?: unknown } : {};
        if (WINE_RUNTIMES.has(topic.id) && /^translator/.test(change.key || "") && change.value) return translatorNeeds(String(change.value));
        if (change.key === "keysPath") return [need("own", KEYS)];
        return runtimeNeeds(topic.id);
      }
      case "effect": return EFFECT_KINDS.has(topic.id) ? effectNeeds(topic.id, detail, topic.moduleId) : null;
      case "window": case "section": {
        const managerId = (topic.detail as { managerId?: string } | undefined)?.managerId;
        if (topic.id === "runtimes") return managerId ? managerNeeds(managerId) : null;
        if (topic.id === "appAction") return runtimeNeeds("capture");
        if (topic.id === "external") return DOCS[`store:${detail}`] || null;
        if (topic.id === "settings" && topic.moduleId && detail) return runtimeNeeds(detail);
        return null;
      }
      case "store": return STORE_TOPICS.has(topic.id) ? DOCS[`store:${detail}`] || null : null;
      case "action":
        if (topic.id === "chooseAppActionTarget") return runtimeNeeds("capture");
        if (topic.id === "setGameSteamClientStart") return [need("own", STEAM_CLIENT)];
        return null;
      case "settings": return topic.id.split(",").includes("startSteamClient") ? [need("own", STEAM_CLIENT)] : null;
      case "tool":
        if (/video|export.*effect|preview/i.test(topic.id)) return featureNeeds(requirements.features.videoExport);
        if (/keys/i.test(topic.id)) return [need("own", KEYS)];
        return null;
      default: return null;
    }
  })();
  return list && list.filter((item, index) => list.findIndex(other => other.kind === item.kind && other.text === item.text) === index);
}

/** The line shown when a subject needs nothing beyond MacLauncher itself. */
export const NOTHING_EXTRA = `Nothing beyond MacLauncher itself, which runs on macOS ${launcherMacOS} or later with Apple Silicon or Intel.`;
