// Website build check for the launcher demo, run after `astro build`:
// - every article a demo action can link exists, including its anchor, for
//   every game type and each of its runtimes;
// - the demo data has one example game per registered game type, and each
//   type has an article;
// - the demo uses the app's React release;
// - the mock's explicit handlers still exist in the launcher's bridge, and the
//   bridge methods it leaves to the generic fallback are listed.
import fs from "node:fs";
import path from "node:path";

const website = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(website, "..");
const dist = path.join(website, "dist");
const { ACTION_ARTICLES, MODULE_ARTICLES, allArticles } = await import("./src/articles.ts");
const failures = [], notes = [];
const demoData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "data/state.json"), "utf8"));
const runtimes = demoData.state.modules.map(info => ({ id: info.id, runtimes: info.runtime?.supported || [] }));

for (const article of new Map(allArticles(runtimes).map(item => [item.path, item])).values()) {
  const [page, anchor] = article.path.split("#");
  const file = path.join(dist, page, "index.html");
  if (!fs.existsSync(file)) { failures.push(`Missing page for "${article.title}": ${article.path}`); continue; }
  if (anchor && !fs.readFileSync(file, "utf8").includes(`id="${anchor}"`)) failures.push(`Missing anchor for "${article.title}": ${article.path}`);
}

// Game types and runtime providers come from the module manifests the
// registry discovers; each game type has an example in the library.
const modulesDir = path.join(repoRoot, "src/modules");
const moduleIds = fs.readdirSync(modulesDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name !== "shared" &&
    fs.existsSync(path.join(modulesDir, entry.name, "main.js")) && fs.existsSync(path.join(modulesDir, entry.name, "manifest.json")))
  .map(entry => JSON.parse(fs.readFileSync(path.join(modulesDir, entry.name, "manifest.json"), "utf8")).id || entry.name);
const dataIds = new Set(demoData.state.modules.map(info => info.id));
const absent = moduleIds.filter(id => !dataIds.has(id)), removed = [...dataIds].filter(id => !moduleIds.includes(id));
const examples = new Set(demoData.state.recents.map(entry => entry.moduleId));
const unexampled = demoData.state.modules.filter(info => info.detection && !examples.has(info.id)).map(info => info.id);
if (unexampled.length) failures.push(`Game types without an example: ${unexampled.join(", ")}. Run pnpm run demo:data.`);
if (absent.length || removed.length) failures.push(`The demo data is out of date (new: ${absent.join(", ") || "none"}; removed: ${removed.join(", ") || "none"}). Run pnpm run demo:data.`);
const unmapped = moduleIds.filter(id => !MODULE_ARTICLES[id]);
if (unmapped.length) notes.push(`Game types shown with the overview article: ${unmapped.join(", ")}`);

// The demo renders the app's renderer, so it must use the app's React release.
const appPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const sitePackage = JSON.parse(fs.readFileSync(path.join(website, "package.json"), "utf8"));
for (const name of ["react", "react-dom"]) {
  const app = String(appPackage.dependencies?.[name] || appPackage.devDependencies?.[name] || "").replace(/^[\^~]/, "");
  const site = sitePackage.dependencies?.[name];
  if (app !== site) failures.push(`The website uses ${name} ${site}; the app uses ${app}.`);
}

const bridgeSource = fs.readFileSync(path.join(repoRoot, "src/modules/shared/web/preload/launcher.js"), "utf8");
const bridge = new Set([...bridgeSource.matchAll(/^ {4}([A-Za-z]+):/gm)].map(match => match[1]));
const mockSource = fs.readFileSync(path.join(import.meta.dirname, "src/mock/api.ts"), "utf8");
const handled = new Set([...mockSource.matchAll(/^ {4}([A-Za-z]+):/gm)].map(match => match[1]));
const stale = [...handled].filter(name => !bridge.has(name));
if (stale.length) failures.push(`The demo answers bridge methods the launcher no longer has: ${stale.join(", ")}`);
const fallback = [...bridge].filter(name => !handled.has(name));
notes.push(`${handled.size} bridge methods answered by the demo; ${fallback.length} use the generic fallback.`);
// A fallback that is not a quiet read names a topic after itself, and should have its own article.
const generic = fallback.filter(name => !/^(get|list|read)[A-Z]/.test(name) && !/^on[A-Z]/.test(name) && !ACTION_ARTICLES[name]);
if (generic.length) notes.push(`Bridge methods shown with the general article: ${generic.join(", ")}`);

for (const note of notes) console.log(`[demo] ${note}`);
if (failures.length) {
  for (const failure of failures) console.error(`[demo] ${failure}`);
  process.exit(1);
}
