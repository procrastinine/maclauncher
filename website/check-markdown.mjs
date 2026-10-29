// Website build check for the Markdown copies, run after `astro build`:
// - every built page has its Markdown copy, linked from the page;
// - every reference document in docs/ has its copy;
// - the copies contain no leftover MDX (imports, components, comments);
// - every link in llms.txt and every link between copies leads to a built file.
import fs from "node:fs";
import path from "node:path";

const website = import.meta.dirname, dist = path.join(website, "dist"), docs = path.resolve(website, "../docs");
const site = "https://procrastinine.github.io/maclauncher/";
const failures = [];
const files = (root, directory = "") => fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(item => {
  const file = path.posix.join(directory, item.name);
  return item.isDirectory() ? files(root, file) : [file];
});
const built = files(dist);

const pages = built.filter(file => file.endsWith("index.html") && !file.startsWith("demo/") && !file.startsWith("_"));
for (const page of pages) {
  const name = path.posix.dirname(page) === "." ? "index" : path.posix.dirname(page);
  if (!fs.existsSync(path.join(dist, `${name}.md`))) failures.push(`${page} has no Markdown copy at ${name}.md`);
  if (!fs.readFileSync(path.join(dist, page), "utf8").includes(`${name}.md"`)) failures.push(`${page} does not link ${name}.md`);
}
for (const file of files(docs).filter(file => file.endsWith(".md")))
  if (!fs.existsSync(path.join(dist, "reference", file))) failures.push(`docs/${file} has no copy under reference/`);

const copies = built.filter(file => file.endsWith(".md") && !file.startsWith("reference/")).concat(["llms-full.txt"]);
for (const file of copies) {
  let fence = false;
  for (const line of fs.readFileSync(path.join(dist, file), "utf8").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && (/^\s*import\s.+\sfrom\s/.test(line) || /<\/?[A-Z][A-Za-z]*[\s/>]/.test(line) || line.includes("{/*")))
      failures.push(`${file} keeps MDX source: ${line.trim().slice(0, 100)}`);
  }
}

// Links within the site lead to built files; anchors are not checked.
const linked = file => [...fs.readFileSync(path.join(dist, file), "utf8").matchAll(/\]\((https:\/\/procrastinine\.github\.io\/maclauncher\/[^)#\s]*)/g)]
  .map(match => match[1].slice(site.length));
for (const file of [...copies, "llms.txt"])
  for (const target of new Set(linked(file))) {
    const resolved = target === "" || target.endsWith("/") ? `${target}index.html` : target;
    if (!fs.existsSync(path.join(dist, resolved))) failures.push(`${file} links a missing file: ${target || "/"}`);
  }

console.log(`[markdown] ${pages.length} pages, ${built.filter(file => file.startsWith("reference/")).length} reference documents checked.`);
if (failures.length) {
  for (const failure of failures) console.error(`[markdown] ${failure}`);
  process.exit(1);
}
