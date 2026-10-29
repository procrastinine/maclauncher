// Website build check for the graphics sample images: images meant to show the
// same scene must come from the same source.
// - both sides of every <Compare before after>;
// - within a <Tabs> block, the samples at the same position in each tab (for
//   example every upscaling method's image of one game).
// Each image is reduced to a 32x18 grayscale thumbnail and correlated with its
// partner; a correlation below 0.6 means the two images show different scenes.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const docs = path.join(import.meta.dirname, "src/content/docs");
const threshold = 0.6;
const failures = [];
const files = fs.readdirSync(docs, { recursive: true }).filter(name => name.endsWith(".mdx")).map(name => path.join(docs, name));

const thumbnails = new Map();
async function thumbnail(file) {
  if (!thumbnails.has(file)) thumbnails.set(file, sharp(file).resize(32, 18, { fit: "fill" }).grayscale().raw().toBuffer().then(data => [...data]));
  return thumbnails.get(file);
}
function correlation(a, b) {
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const ma = mean(a), mb = mean(b);
  let product = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) { product += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
  return product / Math.sqrt(va * vb || 1);
}

let checked = 0, lowest = null;
async function compare(file, label, a, b, imports) {
  const [first, second] = [imports[a], imports[b]];
  if (!first || !second) { failures.push(`${file}: ${label} uses an image that isn't imported (${a}, ${b}).`); return; }
  const value = correlation(await thumbnail(first), await thumbnail(second));
  checked++;
  const description = `${file}: ${label} ${path.basename(first)} and ${path.basename(second)}`;
  if (!lowest || value < lowest.value) lowest = { value, description };
  if (value < threshold) failures.push(`${description} don't show the same scene (correlation ${value.toFixed(2)}).`);
}

for (const file of files) {
  const source = fs.readFileSync(file, "utf8"), name = path.relative(docs, file);
  const imports = {};
  for (const match of source.matchAll(/^import (\w+) from "([^"]+\.(?:png|webp|jpe?g|avif))";/gm)) imports[match[1]] = path.resolve(path.dirname(file), match[2]);
  for (const match of source.matchAll(/<Compare\b([^>]*?)\/>/gs)) {
    const before = match[1].match(/before=\{(\w+)\}/)?.[1], after = match[1].match(/after=\{(\w+)\}/)?.[1];
    await compare(name, "Compare", before, after, imports);
  }
  // Tabs can nest (a game selector holding method tabs); each Tabs block compares
  // only the samples directly inside its own tabs.
  const blocks = [], open = [];
  for (const match of source.matchAll(/<Tabs\b[^>]*>|<\/Tabs>|<TabItem\b|<Sample\s+src=\{(\w+)\}/g)) {
    if (match[0].startsWith("<Tabs")) open.push([]);
    else if (match[0] === "</Tabs>") blocks.push(open.pop());
    else if (match[0] === "<TabItem") open.at(-1)?.push([]);
    else open.at(-1)?.at(-1)?.push(match[1]);
  }
  for (const tabs of blocks) {
    const reference = tabs.find(tab => tab.length);
    for (const tab of tabs) for (let i = 0; i < tab.length; i++) {
      if (tab[i] !== reference[i] && reference[i]) await compare(name, `tab sample ${i + 1}`, reference[i], tab[i], imports);
    }
  }
}

console.log(`[samples] ${checked} image pairs checked${lowest ? `; lowest correlation ${lowest.value.toFixed(2)} (${lowest.description})` : ""}.`);
if (failures.length) {
  for (const failure of failures) console.error(`[samples] ${failure}`);
  process.exit(1);
}
