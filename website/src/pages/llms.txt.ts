// An index of the site's Markdown copies, in the llms.txt format
// (https://llmstxt.org/).
import type { APIRoute } from "astro";
import { REPOSITORY, referenceFiles, referenceTitle, sitePages } from "../markdown";
import { WHOLE_SITE, markdownPath, pageName, siteUrl } from "../markdown-paths";

export const GET: APIRoute = async () => {
  const entries = await sitePages(), home = entries.find(entry => pageName(entry.id) === "index");
  const url = (file: string) => new URL(file, siteUrl).href;
  const tagline = home?.data.hero?.tagline;
  const lines = [
    "# MacLauncher",
    "",
    `> ${typeof tagline === "string" && tagline ? tagline : home?.data.description || ""}`,
    "",
    `Every page of ${siteUrl.href} is also available as Markdown at its own address with ".md" added ` +
      `(the home page is index.md). The whole site is one file at ${url(WHOLE_SITE)}. ` +
      `The repository's reference documentation is copied under ${url("reference/")}. ` +
      `Source code and releases: ${REPOSITORY}.`,
    "",
    "## Pages",
    "",
    ...entries.map(entry => `- [${entry.data.title}](${url(markdownPath(entry.id))})${entry.data.description ? `: ${entry.data.description}` : ""}`),
    "",
    "## Reference documentation",
    "",
    ...referenceFiles().map(file => `- [${referenceTitle(file)}](${url(`reference/${file}`)})`),
    "",
    "## Optional",
    "",
    `- [The whole site in one file](${url(WHOLE_SITE)})`,
    `- [Interactive demo](${url("demo/")}): the real launcher interface on example data; needs JavaScript`,
    ""
  ];
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
