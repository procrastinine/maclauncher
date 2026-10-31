// Graphics feature requirements for the "Macs and macOS versions" page. The
// numbers come from the tables in docs/runtimes/SYSTEM_REQUIREMENTS.md, which
// are generated from the app's shared capability code, so the site never
// restates a minimum macOS version by hand.
import fs from "node:fs";
import path from "node:path";

// Astro builds from the website directory, beside the repository's docs.
const SOURCE = path.resolve(process.cwd(), "../docs/runtimes/SYSTEM_REQUIREMENTS.md");
const BLOCKS = ["platform-requirements", "selected-graphics-requirements"];

export type FeatureGroup = { macOS: string; everyMac: string[]; supportedGpu: string[]; appleSilicon: string[] };
export const COLUMNS = ["macOS", "Every Mac", "Macs whose GPU supports it", "Apple Silicon only"];

// One generated table: its header names the feature, minimum macOS and processor columns.
function rows(text: string, name: string) {
  const block = text.match(new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`));
  if (!block) throw new Error(`docs/runtimes/SYSTEM_REQUIREMENTS.md has no generated ${name} table.`);
  const [header, , ...body] = block[1].trim().split("\n").map(line => line.split("|").slice(1, -1).map(cell => cell.trim()));
  const macOS = header.findIndex(cell => /minimum macos/i.test(cell)), device = header.findIndex(cell => /processor/i.test(cell));
  return body.map(cells => ({ feature: cells[0], macOS: cells[macOS], device: cells[device] }));
}

/** Features grouped by the earliest macOS version that supports them, oldest first. */
export function featureGroups(): FeatureGroup[] {
  const text = fs.readFileSync(SOURCE, "utf8"), groups = new Map<string, FeatureGroup>();
  for (const row of BLOCKS.flatMap(name => rows(text, name))) {
    const group = groups.get(row.macOS) ?? { macOS: row.macOS, everyMac: [], supportedGpu: [], appleSilicon: [] };
    const list = /intel/i.test(row.device) ? group.everyMac : /apple silicon/i.test(row.device) ? group.appleSilicon
      : /metal device/i.test(row.device) ? group.supportedGpu : group.everyMac;
    if (!list.includes(row.feature)) list.push(row.feature);
    groups.set(row.macOS, group);
  }
  const parts = (version: string) => version.split(".").map(Number);
  return [...groups.values()].sort((a, b) => {
    const [x, y] = [parts(a.macOS), parts(b.macOS)];
    return (x[0] - y[0]) || ((x[1] || 0) - (y[1] || 0));
  });
}

/** The same table as Markdown, for the site's Markdown copies. */
export function featureTableMarkdown() {
  const cell = (items: string[]) => items.join(", ") || "None";
  return [
    `| ${COLUMNS.join(" | ")} |`,
    `| ${COLUMNS.map(() => "---").join(" | ")} |`,
    ...featureGroups().map(group =>
      `| ${group.macOS} | ${cell(group.everyMac)} | ${cell(group.supportedGpu)} | ${cell(group.appleSilicon)} |`)
  ].join("\n");
}
