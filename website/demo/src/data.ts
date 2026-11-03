import { version } from "../../../package.json";

// Keep the generated state as one cacheable data asset shared by the demo views.
const response = await fetch(new URL("../data/state.json", import.meta.url));
if (!response.ok) throw new Error(`Demo state returned HTTP ${response.status}.`);
export const demoData = await response.json();
// Check for Updates names the app's version from its package.json.
demoData.state.appUpdate.currentVersion = version;

// The launcher gives a game without its own icon the module's icon file. The
// demo attaches the same files, which Vite publishes as demo assets.
const moduleIcons = import.meta.glob<string>("../../../src/modules/*/resources/icon.png", { eager: true, query: "?url", import: "default" });
for (const game of demoData.state.recents) {
  const icon = !game.iconUrl && moduleIcons[`../../../src/modules/${game.moduleId}/resources/icon.png`];
  if (icon) Object.assign(game, { iconUrl: icon, iconSource: "module-default" });
}
