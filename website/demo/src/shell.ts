// The demo page: the launcher's menu and library on the left, its windows as
// panels over it, and on the right what the latest action needs and the
// articles about it. Every launcher view on the page shares one in-memory
// state.
import "./shell.css";
import { demoData } from "./data";
import type { LauncherState } from "../../../src/renderer/src/ui/types";
import { ARTICLES, articlesFor, type Article } from "./articles";
import { createStore, type DemoTopic, type DemoWindow } from "./mock/store";
import { NEED_LABELS, NOTHING_EXTRA, needsFor } from "./needs";
import { createMenuBar, type MenuEntry, type MenuItem } from "./menubar";

const siteRoot = new URL("../", window.location.href);
const element = <T extends Element>(selector: string) => document.querySelector(selector) as T;
const library = element<HTMLIFrameElement>(".libraryFrame");
const utility = element<HTMLDivElement>(".utilityWindow");
const utilityFrame = element<HTMLIFrameElement>(".utilityFrame");
const utilityTitle = element<HTMLSpanElement>(".utilityTitle");
const lead = element<HTMLParagraphElement>(".articleLead");
const list = element<HTMLOListElement>(".articleList");
const preview = element<HTMLIFrameElement>(".articlePreview");
const open = element<HTMLAnchorElement>(".articleOpen");
const needs = element<HTMLElement>(".needs");
const needsList = element<HTMLUListElement>(".needsList");
const menu = element<HTMLElement>(".demoMenu");
const launcherPane = element<HTMLElement>(".launcherPane");
const utilityBar = element<HTMLElement>(".utilityBar");

// Embedded in the site's home page, the demo drops its own bar, and articles
// open in the page around it.
if (new URLSearchParams(window.location.search).has("embed")) {
  document.documentElement.classList.add("embedded");
  open.target = "_top";
}

// The article column follows the site's theme: the page around an embedded
// demo, or else the site's saved theme choice and the system setting.
const systemLight = window.matchMedia("(prefers-color-scheme: light)");
function surroundingTheme() {
  try {
    if (window.parent !== window) return window.parent.document.documentElement.dataset.theme;
  } catch {}
}
function savedTheme() {
  try {
    return localStorage.getItem("starlight-theme");
  } catch {}
}
function followSiteTheme() {
  const theme = surroundingTheme() || savedTheme();
  document.documentElement.dataset.siteTheme = theme === "light" || theme === "dark" ? theme : systemLight.matches ? "light" : "dark";
}
followSiteTheme();
systemLight.addEventListener("change", followSiteTheme);
window.addEventListener("storage", followSiteTheme);
try {
  if (window.parent !== window) new MutationObserver(followSiteTheme)
    .observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
} catch {}

const LEADS: Record<string, string> = {
  game: "Selecting a game opens its inspector: runtime, version, tools and graphics for that game.",
  runtime: "In MacLauncher, this game would now start with the runtime you picked.",
  version: "In MacLauncher, this game would now use the version you picked.",
  "runtime-settings": "In MacLauncher, this setting would apply the next time the game starts.",
  play: "In MacLauncher, Play prepares the runtime, downloads anything missing after asking, and starts the game.",
  add: "In MacLauncher, you can drag a game folder or file onto the library, and it works out the engine and runtime.",
  effect: "In MacLauncher, this change would apply to the running game straight away.",
  window: "MacLauncher opens this as its own window.",
  "section:settings": "Settings has a section for the launcher and one for each game type, with a tab for each runtime's settings. Changes save straight away.",
  "section:runtimes": "Each runtime has its own page in Runtimes, where you can refresh the version list, install or remove versions, and pick the default.",
  "section:external": "External finds games already on this Mac and downloads the ones you own, with a tab for each store.",
  "runtime-action": "In MacLauncher, this would download, remove or select a runtime version.",
  settings: "In MacLauncher, this setting would be saved straight away.",
  "settings:checkForUpdatesAtLaunch": "In MacLauncher, this setting would be saved straight away. While it is on, each start asks GitHub for a newer release.",
  "action:appUpdate": "In MacLauncher, Check for Updates asks GitHub for the newest release and offers to download and install a newer one. The demo contacts nothing and reports this version as current.",
  "action:locateGame": "In MacLauncher, Locate… asks for the game's new location, checks that the same kind of game is there and points the library entry at it, keeping its saves and settings.",
  "action:findMissingGames": "MacLauncher checks each game's saved location without reading its folder, then counts or selects the games whose files are missing.",
  store: "In MacLauncher, this would use your own store account.",
  "store:scan": "MacLauncher looks through the stores' install folders on this Mac for games you already have. Nothing is downloaded.",
  "store:download": "In MacLauncher, this would download the game with your own store account. Finished copies are listed under Downloaded, ready to import.",
  "store:import": "In MacLauncher, the games you picked would join the library, each with its engine and runtime worked out.",
  saves: "Saves finds where this game keeps its saves.",
  cheats: "Cheats change the game while it runs.",
  tool: "In MacLauncher, this tool would run on the game's files and write its results to a separate folder.",
  entry: "In MacLauncher, this picks what starts when you press Play.",
  "effect:master": "In MacLauncher, this switches the whole effect chain off or on without changing any of it.",
  "effect:clear": "In MacLauncher, Clear effects empties the chain, and Undo brings it back until your next edit.",
  "effect:game-resolution": "In MacLauncher, the game itself would render at this size, leaving the window as it is.",
  "effect:row-toggle": "In MacLauncher, this row would be set aside with its settings kept.",
  "effect:row-remove": "In MacLauncher, this row would leave the chain.",
  "effect:row-order": "In MacLauncher, the image would now pass through the rows in this order.",
  "runtime-settings:arguments": "In MacLauncher, these arguments would be passed to the game the next time it starts.",
  "runtime-settings:network": "In MacLauncher, the game would start with this network access the next time it runs.",
  action: "In MacLauncher, this would happen for real.",
  "action:createGameCommand": "In MacLauncher, this saves a .command file that starts the game when opened, with its current runtime and settings.",
  "action:revealInFinder": "In MacLauncher, this shows the file in Finder.",
  "action:setLibrarySort": "In MacLauncher, the library keeps this order between launches.",
  "action:forgetGames": "In MacLauncher, this asks once, then removes the selected games from the library. Their files stay where they are.",
  "action:deleteGames": "In MacLauncher, this asks once, then moves the selected games to the Trash.",
  "window:appAction": "In MacLauncher, File → Apply Graphics… lists the displays and the windows of other apps. Choosing one starts graphics on it and adds a running entry to the library, where its effects are edited like a game's.",
  "action:chooseAppActionTarget": "In MacLauncher, the chosen window now shows through its effect chain. Its entry stays in the library until the session stops.",
  "action:openAppActionPickerLink": "In MacLauncher, this opens Privacy & Security in System Settings, where Screen & System Audio Recording can be allowed.",
  "action:stopSession": "In MacLauncher, stopping a window graphics session returns the window to normal and removes its entry from the library.",
  "action:removeSessionTarget": "In MacLauncher, this window leaves the session. Removing the last one stops the session.",
  "action:stopGame": "In MacLauncher, this stops the running game.",
  "action:saveEffectsPreset": "In MacLauncher, the effect chain is saved as a preset. Presets are listed in Settings → Graphics and can be applied to any game.",
  "action:deleteEffectsPreset": "In MacLauncher, the preset is deleted. Games that used it keep their own copy of the chain.",
  "action:setGameSteamClientStart": "In MacLauncher, this decides whether Play starts the Steam client for Mac first when it isn't running: ask each time, start it automatically or leave it closed.",
  "settings:startSteamClient": "In MacLauncher, this is the default for every Windows game that uses the Steam client bridge. Each game can override it.",
  "settings:translatorEnvironment": "In MacLauncher, these environment variables would apply to every game that uses this translator.",
  "effect:output": "In MacLauncher, this output setting would apply to the running game straight away."
};

function articleUrl(article: Article) {
  return new URL(article.path, siteRoot).href;
}

let previewAnchor = "";
preview.addEventListener("load", () => {
  const view = preview.contentWindow, target = previewAnchor && view?.document.getElementById(previewAnchor);
  if (!view || !target) return;
  // The page's own scroll padding clears its header and contents bar.
  const padding = parseFloat(view.getComputedStyle(view.document.documentElement).scrollPaddingTop) || 0;
  view.scrollTo({ top: target.getBoundingClientRect().top + view.scrollY - padding });
});

function show(articles: Article[], text: string) {
  lead.textContent = text;
  list.replaceChildren(...articles.map((article, index) => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = articleUrl(article);
    link.textContent = article.title;
    link.addEventListener("click", event => {
      event.preventDefault();
      select(index);
    });
    item.append(link);
    return item;
  }));
  const select = (index: number) => {
    list.querySelectorAll("li").forEach((item, position) => item.classList.toggle("current", position === index));
    const url = new URL(open.href = articleUrl(articles[index]));
    // A fragment navigation inside a frame also scrolls every page around it,
    // so the preview loads without one and scrolls only its own document.
    previewAnchor = decodeURIComponent(url.hash.slice(1));
    url.hash = "";
    url.searchParams.set("preview", "");
    preview.src = url.href;
  };
  if (articles.length) select(0);
}

// The requirements of what the action touches: its game, runtime, package,
// effect, store or tool. Actions with no subject of their own hide the list.
function showNeeds(value: DemoTopic) {
  const items = needsFor(value, store.state);
  needs.hidden = !items;
  if (!items) return;
  needsList.replaceChildren(...(items.length ? items.map(need => {
    const item = document.createElement("li"), label = document.createElement("span");
    label.className = "needKind";
    label.textContent = NEED_LABELS[need.kind];
    item.append(label, need.text);
    return item;
  }) : [Object.assign(document.createElement("li"), { className: "needNone", textContent: NOTHING_EXTRA })]));
}

function topic(value: DemoTopic) {
  showNeeds(value);
  show(articlesFor(value), LEADS[`${value.kind}:${value.id}`] || LEADS[value.kind] || "This is part of the full launcher.");
}

// Launcher windows open over the library as macOS windows: the traffic
// lights close, minimize and zoom, the title bar drags the window, and a
// double click on it zooms. A window minimized and opened again returns where
// it was. The library is the key window after a click inside it, and the
// window's controls then turn gray as in macOS.
let minimized = false, keyWindow: "library" | "utility" = "library", offset = { x: 0, y: 0 };
function setKey(which: "library" | "utility") {
  keyWindow = which;
  utility.classList.toggle("inactive", which === "library");
}
function place(x: number, y: number) {
  offset = { x, y };
  utility.style.setProperty("--window-x", `${x}px`);
  utility.style.setProperty("--window-y", `${y}px`);
}

function openWindow({ title, search }: DemoWindow) {
  const src = `launcher.html?${new URLSearchParams(search)}`;
  utilityTitle.textContent = title;
  if (utilityFrame.getAttribute("src") !== src) utilityFrame.src = src;
  if (utility.hidden && !minimized) { utility.classList.remove("zoomed"); place(0, 0); }
  minimized = false;
  utility.hidden = false;
  setKey("utility");
}

function closeWindow() {
  utility.hidden = true;
  minimized = false;
  utilityFrame.removeAttribute("src");
  setKey("library");
}
function minimizeWindow() {
  utility.classList.add("minimizing");
  window.setTimeout(() => {
    utility.classList.remove("minimizing");
    utility.hidden = true;
    minimized = true;
    setKey("library");
  }, 240);
}
const zoomWindow = () => utility.classList.toggle("zoomed");
element<HTMLButtonElement>(".light.close").addEventListener("click", closeWindow);
element<HTMLButtonElement>(".light.minimize").addEventListener("click", minimizeWindow);
element<HTMLButtonElement>(".light.zoom").addEventListener("click", zoomWindow);
utility.addEventListener("pointerdown", () => setKey("utility"));
utilityBar.addEventListener("dblclick", event => { if (!(event.target as Element).closest(".trafficLights")) zoomWindow(); });
// The title bar stays below the menu bar and inside the screen.
let drag: { id: number; x: number; y: number; from: { x: number; y: number } } | null = null;
utilityBar.addEventListener("pointerdown", event => {
  if (event.button !== 0 || (event.target as Element).closest(".trafficLights") || utility.classList.contains("zoomed")) return;
  event.preventDefault();
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, from: offset };
  utilityBar.setPointerCapture(event.pointerId);
  launcherPane.classList.add("draggingWindow");
});
utilityBar.addEventListener("pointermove", event => {
  if (!drag || event.pointerId !== drag.id) return;
  const pane = launcherPane.getBoundingClientRect(), rect = utility.getBoundingClientRect();
  const left = rect.left - offset.x, top = rect.top - offset.y, menuBottom = menu.getBoundingClientRect().bottom;
  const x = drag.from.x + event.clientX - drag.x, y = drag.from.y + event.clientY - drag.y;
  place(Math.min(Math.max(x, pane.left + 80 - rect.width - left), pane.right - 80 - left),
    Math.min(Math.max(y, menuBottom - top), pane.bottom - 28 - top));
});
const endDrag = () => { drag = null; launcherPane.classList.remove("draggingWindow"); };
utilityBar.addEventListener("pointerup", endDrag);
utilityBar.addEventListener("pointercancel", endDrag);
// A click in the library or a window moves focus into its frame.
window.addEventListener("blur", () => window.setTimeout(() => {
  if (document.activeElement === library) setKey("library");
  else if (document.activeElement === utilityFrame) setKey("utility");
}));

// The menu bar holds the Apple menu and the launcher's own macOS menus, with
// the items and shortcuts the launcher has. The commands the demo carries out
// are the app menu's Check for Updates…, Credits and Settings…, File → Open…,
// Apply Graphics… and Close Window, View → Library, External and Runtimes,
// and Window → Minimize, Zoom and the window list. Their topics go through the
// store, as the launcher's own do, so the store's record of the latest topic
// stays current. The other items are dimmed.
const utilityWindow = (view: string, title: string, search: Record<string, string> = {}) => () => {
  store.topic({ kind: "window", id: view, ...(search.moduleId ? { moduleId: search.moduleId } : {}) });
  openWindow({ title, search: { view, ...search } });
};
const dimmed = (label: string, shortcut?: string, submenu?: boolean): MenuItem => ({ label, shortcut, submenu });
const windowOpen = () => !utility.hidden;
const focusLibrary = () => { library.focus(); setKey("library"); };
const APPLE_LOGO = '<svg viewBox="0 0 814 1000" aria-hidden="true"><path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"/></svg>';
createMenuBar(menu, [
  { title: "Apple", className: "appleMenu", icon: APPLE_LOGO, entries: () => [
    dimmed("About This Mac"), "separator", dimmed("System Settings…"), dimmed("App Store"), "separator",
    dimmed("Recent Items", undefined, true), "separator", dimmed("Force Quit…", "⌥⌘⎋"), "separator",
    dimmed("Sleep"), dimmed("Restart…"), dimmed("Shut Down…"), "separator", dimmed("Lock Screen", "⌃⌘Q"), dimmed("Log Out…", "⇧⌘Q")
  ] },
  { title: "MacLauncher", className: "appMenu", entries: () => [
    dimmed("About MacLauncher"),
    { label: "Check for Updates…", run: () => store.topic({ kind: "action", id: "appUpdate" }) },
    { label: "Credits", run: utilityWindow("credits", "Credits") },
    "separator",
    { label: "Settings…", shortcut: "⌘,", run: utilityWindow("settings", "Settings") },
    "separator", dimmed("Services", undefined, true), "separator",
    dimmed("Hide MacLauncher", "⌘H"), dimmed("Hide Others", "⌥⌘H"), dimmed("Show All"), "separator",
    dimmed("Quit MacLauncher", "⌘Q")
  ] },
  { title: "File", entries: () => [
    { label: "Open…", shortcut: "⌘O", run: () => store.topic({ kind: "add", id: "dialog" }) },
    { label: "Apply Graphics…", run: utilityWindow("appAction", "Apply Graphics", { moduleId: "window", actionId: "applyGraphics" }) },
    "separator",
    { label: "Close Window", shortcut: "⌘W", run: windowOpen() ? closeWindow : undefined }
  ] },
  { title: "Edit", className: "extraMenu", entries: () => [
    dimmed("Undo", "⌘Z"), dimmed("Redo", "⇧⌘Z"), "separator", dimmed("Cut", "⌘X"), dimmed("Copy", "⌘C"), dimmed("Paste", "⌘V"),
    dimmed("Paste and Match Style", "⌥⇧⌘V"), dimmed("Delete"), dimmed("Select All", "⌘A"), "separator", dimmed("Speech", undefined, true)
  ] },
  { title: "View", entries: () => [
    { label: "Library", run: focusLibrary },
    { label: "External", run: utilityWindow("external", "External") },
    { label: "Runtimes", run: utilityWindow("runtimes", "Runtimes") },
    "separator", dimmed("Reload", "⌘R"), dimmed("Force Reload", "⇧⌘R"), "separator",
    dimmed("Actual Size", "⌘0"), dimmed("Zoom In", "⌘+"), dimmed("Zoom Out", "⌘−"), "separator", dimmed("Enter Full Screen", "⌃⌘F")
  ] },
  { title: "Tools", className: "extraMenu", entries: () => [
    dimmed("Toggle Tools Panel", "⇧⌘T"), dimmed("Open Tools Panel"), dimmed("Close Tools Panel")
  ] },
  { title: "Window", className: "extraMenu", entries: (): MenuEntry[] => [
    { label: "Minimize", shortcut: "⌘M", run: windowOpen() ? minimizeWindow : undefined },
    { label: "Zoom", run: windowOpen() ? zoomWindow : undefined },
    "separator", dimmed("Bring All to Front"), "separator",
    { label: "MacLauncher", run: focusLibrary, mark: keyWindow === "library" || utility.hidden ? "check" : undefined },
    ...(windowOpen() || minimized ? [{ label: utilityTitle.textContent || "", run: () => {
      if (minimized) { minimized = false; utility.hidden = false; }
      setKey("utility");
    }, mark: minimized ? "diamond" as const : keyWindow === "utility" ? "check" as const : undefined }] : [])
  ] },
  { title: "Help", entries: () => [dimmed("Show Log in Finder")] }
]);

const store = createStore((demoData as unknown as { state: LauncherState }).state, { topic, openWindow, closeWindow });
window.MacLauncherDemo = { store, host: { topic, openWindow, closeWindow } };
library.src = "launcher.html";
show([ARTICLES.intro, ARTICLES.howGamesRun, ARTICLES.graphics],
  "Try selecting a game, changing its runtime, picking an effect in Graphics, or opening Apply Graphics, Runtimes and External from the menu bar.");
