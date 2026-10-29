// Plain Markdown copies of the site, for readers that handle text better
// than web pages, such as language models. Page bodies are the docs sources
// with their components written out as text, and links lead to other
// Markdown copies. The repository's reference documentation is copied under
// reference/ with links outside it pointing at GitHub.
import fs from "node:fs";
import path from "node:path";
import { getCollection, type CollectionEntry } from "astro:content";
import { sidebar } from "./sidebar.mjs";
import { htmlPath, markdownPath, pageName, siteUrl } from "./markdown-paths";

type Entry = CollectionEntry<"docs">;
type SidebarItem = string | { link?: string; items?: SidebarItem[]; autogenerate?: { directory: string } };

export const REPOSITORY = "https://github.com/procrastinine/maclauncher";
const BRANCH = "master";
// Astro builds from the website directory, beside the repository's docs.
const REFERENCE_ROOT = path.resolve(process.cwd(), "../docs");

/** Every docs page, in the order of the site's navigation, home page first. */
export async function sitePages(): Promise<Entry[]> {
  const entries = await getCollection("docs"), ordered: Entry[] = [];
  const add = (entry?: Entry) => { if (entry && !ordered.includes(entry)) ordered.push(entry); };
  const order = (entry: Entry) => entry.data.sidebar?.order ?? Number.MAX_SAFE_INTEGER;
  const walk = (items: SidebarItem[]) => {
    for (const item of items) {
      if (typeof item === "string") add(entries.find(entry => entry.id === item));
      else if (item.items) walk(item.items);
      else if (item.autogenerate) {
        const directory = item.autogenerate.directory;
        entries.filter(entry => entry.id === directory || entry.id.startsWith(`${directory}/`))
          .sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id)).forEach(add);
      }
    }
  };
  add(entries.find(entry => pageName(entry.id) === "index"));
  walk(sidebar as SidebarItem[]);
  entries.forEach(add);
  return ordered;
}

// A link on this site leads to the Markdown copy of its page; a link to the
// reference documentation on GitHub leads to its copy here.
function siteLink(target: string, pages: Set<string>) {
  const reference = target.match(new RegExp(`^${REPOSITORY}/blob/[^/]+/docs/([^#]+\\.md)(#.*)?$`));
  if (reference) return new URL(`reference/${reference[1]}${reference[2] || ""}`, siteUrl).href;
  if (target !== siteUrl.pathname.slice(0, -1) && !target.startsWith(siteUrl.pathname)) return target;
  const [pathname, hash] = target.split("#");
  const name = pathname.slice(siteUrl.pathname.length).replace(/\/$/, "") || "index";
  const file = pages.has(name) ? markdownPath(name) : pathname.slice(siteUrl.pathname.length);
  return new URL(file, siteUrl).href + (hash ? `#${hash}` : "");
}

const attributes = (source: string): Record<string, string> =>
  Object.fromEntries([...source.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
// A line that is one whole tag: <Name attributes>, <Name attributes /> or </Name>.
const WHOLE_TAG = /^<(\/?)([A-Za-z][\w.]*)((?:\s[^>]*?)?)\s*(\/?)>$/;
const ASIDE = /^:::(note|tip|caution|danger)(?:\[(.*)\])?$/;

/** A docs page body with its components written out as Markdown. */
function convertBody(body: string, pages: Set<string>): string {
  const out: string[] = [];
  // Component content is indented in the source; each open component strips
  // the indentation of its first content line from the lines inside it.
  const open: Array<{ indent: number | null }> = [];
  let fence = false, aside = false, cardLink = "";
  const dedent = (line: string) => {
    const top = open[open.length - 1];
    if (!line.trim()) return "";
    if (!top) return line;
    const indent = line.length - line.trimStart().length;
    top.indent ??= indent;
    return line.slice(Math.min(indent, top.indent));
  };
  const emit = (line: string) => out.push(aside ? (line ? `> ${line}` : ">") : line);
  const inline = (line: string) => line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => alt ? `*Image: ${alt}.*` : "")
    .replace(/\]\(([^)\s]+)\)/g, (_, target: string) => `](${siteLink(target, pages)})`)
    .replace(/<span id="[^"]*"><\/span>/g, "");
  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) { fence = !fence; emit(dedent(line)); continue; }
    if (fence) { emit(dedent(line)); continue; }
    if (/^import\s.+\sfrom\s/.test(trimmed) || /^\{\/\*.*\*\/\}$/.test(trimmed)) continue;
    const asideStart = trimmed.match(ASIDE);
    if (asideStart) {
      aside = true;
      emit(`**${asideStart[2] || asideStart[1][0].toUpperCase() + asideStart[1].slice(1)}:**`);
      continue;
    }
    if (aside && trimmed === ":::") { aside = false; continue; }
    if (/^<[A-Za-z/]/.test(trimmed)) {
      let tag = trimmed;
      while (!tag.includes(">") && index + 1 < lines.length) tag += ` ${lines[++index].trim()}`;
      const match = tag.match(WHOLE_TAG);
      if (match) {
        const [, closing, name, source, selfClosing] = match, props = attributes(source);
        if (closing) {
          open.pop();
          if (name === "a") cardLink = "";
          emit("");
          continue;
        }
        const text = (() => {
          switch (name) {
            case "a": cardLink = props.href ? siteLink(props.href, pages) : ""; return null;
            case "Card": return `**${cardLink ? `[${props.title}](${cardLink})` : props.title}**`;
            case "TabItem": return `**${props.label}**`;
            case "LinkCard": return `- [${props.title}](${siteLink(props.href, pages)})${props.description ? `: ${props.description}` : ""}`;
            case "Sample": return `*Image: ${props.alt}.*${props.caption ? ` ${props.caption}` : ""}`;
            case "Compare": return `*Image comparison, ${props.beforeLabel || "Before"} and ${props.afterLabel || "After"}: ${props.alt}.*${props.caption ? ` ${props.caption}` : ""}`;
            case "DemoEmbed": return `[Try the launcher](${new URL("demo/", siteUrl).href}): the real launcher interface, running in the browser on example data.`;
            default: return null;
          }
        })();
        if (!selfClosing) open.push({ indent: null });
        // Link cards form one list; everything else is its own paragraph.
        if (text !== null) { emit(text); if (name !== "LinkCard") emit(""); }
        continue;
      }
    }
    emit(inline(dedent(line)));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** One page as Markdown: its title, summary and address, then its text. */
export function pageMarkdown(entry: Entry, pages: Set<string>): string {
  const tagline = entry.data.hero?.tagline;
  return [
    `# ${entry.data.title}`,
    ...(entry.data.description ? [`> ${entry.data.description}`] : []),
    ...(typeof tagline === "string" && tagline ? [tagline] : []),
    `Web page: ${new URL(htmlPath(entry.id), siteUrl).href}`,
    convertBody(entry.body || "", pages)
  ].join("\n\n") + "\n";
}

export const pageNames = (entries: Entry[]) => new Set(entries.map(entry => pageName(entry.id)));

/** The reference documentation's Markdown files, relative to docs/. */
export function referenceFiles(directory = ""): string[] {
  return fs.readdirSync(path.join(REFERENCE_ROOT, directory), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(item => {
      const file = directory ? `${directory}/${item.name}` : item.name;
      return item.isDirectory() ? referenceFiles(file) : item.name.endsWith(".md") ? [file] : [];
    });
}

export function referenceTitle(file: string) {
  const text = fs.readFileSync(path.join(REFERENCE_ROOT, file), "utf8");
  return text.match(/^#\s+(.+)$/m)?.[1].trim() || file;
}

/** A reference file, with links outside the reference documentation pointing at GitHub. */
export function referenceMarkdown(file: string): string {
  let fence = false;
  const lines = fs.readFileSync(path.join(REFERENCE_ROOT, file), "utf8").split("\n").map(line => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return line;
    return line.replace(/\]\(([^)\s{}]+)\)/g, (whole, target: string) => {
      if (/^([a-z]+:|#)/i.test(target)) return whole;
      const [pathname, hash] = target.split("#");
      const resolved = path.posix.normalize(path.posix.join("docs", path.posix.dirname(file), pathname));
      if (resolved.startsWith("docs/") && resolved.endsWith(".md")) return whole;
      return `](${REPOSITORY}/blob/${BRANCH}/${resolved}${hash ? `#${hash}` : ""})`;
    });
  });
  return `${lines.join("\n").trimEnd()}\n\nSource: ${REPOSITORY}/blob/${BRANCH}/docs/${file}\n`;
}
