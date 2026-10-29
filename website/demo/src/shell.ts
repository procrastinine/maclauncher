// The demo page: the launcher's library on the left, its windows as panels
// over it, and the articles for the latest action on the right. Every
// launcher view on the page shares one in-memory state.
import "./shell.css";
import demoData from "../data/state.json";
import type { LauncherState } from "../../../src/renderer/src/ui/types";
import { ARTICLES, articlesFor, type Article } from "./articles";
import { createStore, type DemoTopic, type DemoWindow } from "./mock/store";

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

// Embedded in the site's home page, the demo drops its own bar, and articles
// open in the page around it.
if (new URLSearchParams(window.location.search).has("embed")) {
  document.documentElement.classList.add("embedded");
  open.target = "_top";
}

const LEADS: Record<string, string> = {
  game: "Selecting a game opens its inspector: runtime, version, tools and graphics for that game.",
  runtime: "In MacLauncher, this game would now start with the runtime you picked.",
  version: "In MacLauncher, this game would now use the version you picked.",
  "runtime-settings": "In MacLauncher, this setting would apply the next time the game starts.",
  play: "In MacLauncher, Play prepares the runtime, downloads anything missing after asking, and starts the game.",
  add: "In MacLauncher, you can drag a game folder or file onto the library, and it works out the engine and runtime.",
  effect: "In MacLauncher, this change would apply to the running game straight away.",
  window: "MacLauncher opens this as its own window.",
  "runtime-action": "In MacLauncher, this would download, remove or select a runtime version.",
  settings: "In MacLauncher, this setting would be saved straight away.",
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
  "action:deleteGames": "In MacLauncher, this asks once, then moves the selected games to the Trash."
};

function articleUrl(article: Article) {
  return new URL(article.path, siteRoot).href;
}

let previewAnchor = "";
preview.addEventListener("load", () => {
  const view = preview.contentWindow, target = previewAnchor && view?.document.getElementById(previewAnchor);
  if (!view || !target) return;
  const header = view.document.querySelector("header")?.getBoundingClientRect().height || 0;
  view.scrollTo({ top: target.getBoundingClientRect().top + view.scrollY - header - 16 });
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

function topic(value: DemoTopic) {
  show(articlesFor(value), LEADS[`${value.kind}:${value.id}`] || LEADS[value.kind] || "This is part of the full launcher.");
}

function openWindow({ title, search }: DemoWindow) {
  const src = `launcher.html?${new URLSearchParams(search)}`;
  utilityTitle.textContent = title;
  if (utility.hidden || utilityFrame.getAttribute("src") !== src) utilityFrame.src = src;
  utility.hidden = false;
}

element<HTMLButtonElement>(".utilityClose").addEventListener("click", () => {
  utility.hidden = true;
  utilityFrame.removeAttribute("src");
});

const store = createStore((demoData as unknown as { state: LauncherState }).state, { topic, openWindow });
window.MacLauncherDemo = { store, host: { topic, openWindow } };
library.src = "launcher.html";
show([ARTICLES.intro, ARTICLES.howGamesRun, ARTICLES.graphics],
  "Try selecting a game, changing its runtime, picking an effect in Graphics, or opening Runtimes and External.");
