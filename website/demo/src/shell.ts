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

function openWindow({ title, search }: DemoWindow) {
  const src = `launcher.html?${new URLSearchParams(search)}`;
  utilityTitle.textContent = title;
  if (utility.hidden || utilityFrame.getAttribute("src") !== src) utilityFrame.src = src;
  utility.hidden = false;
}

function closeWindow() {
  utility.hidden = true;
  utilityFrame.removeAttribute("src");
}
element<HTMLButtonElement>(".utilityClose").addEventListener("click", closeWindow);

// The launcher's own menu commands: File → Open… and Apply Graphics…, the
// app menu's Settings…, Credits and Check for Updates…, and the Window menu's
// Runtimes and External. Their topics go through the store, as the launcher's
// own do, so the store's record of the latest topic stays current.
const utilityWindow = (view: string, title: string, search: Record<string, string> = {}) => () => {
  store.topic({ kind: "window", id: view, ...(search.moduleId ? { moduleId: search.moduleId } : {}) });
  openWindow({ title, search: { view, ...search } });
};
const MENU: Array<[string, () => void]> = [
  ["Open…", () => store.topic({ kind: "add", id: "dialog" })],
  ["Apply Graphics…", utilityWindow("appAction", "Apply Graphics", { moduleId: "window", actionId: "applyGraphics" })],
  ["Settings…", utilityWindow("settings", "Settings")],
  ["Runtimes", utilityWindow("runtimes", "Runtimes")],
  ["External", utilityWindow("external", "External")],
  ["Credits", utilityWindow("credits", "Credits")],
  ["Check for Updates…", () => store.topic({ kind: "action", id: "appUpdate" })]
];
menu.append(...MENU.map(([label, run]) => {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", run);
  return button;
}));

const store = createStore((demoData as unknown as { state: LauncherState }).state, { topic, openWindow, closeWindow });
window.MacLauncherDemo = { store, host: { topic, openWindow, closeWindow } };
library.src = "launcher.html";
show([ARTICLES.intro, ARTICLES.howGamesRun, ARTICLES.graphics],
  "Try selecting a game, changing its runtime, picking an effect in Graphics, or opening Apply Graphics, Runtimes and External from the menu.");
