// The whole site as one Markdown document, in navigation order.
import type { APIRoute } from "astro";
import { pageMarkdown, pageNames, sitePages } from "../markdown";
import { INDEX, siteUrl } from "../markdown-paths";

export const GET: APIRoute = async () => {
  const entries = await sitePages(), pages = pageNames(entries);
  const header = `This is the whole MacLauncher website (${siteUrl.href}) as Markdown. ` +
    `${new URL(INDEX, siteUrl).href} lists every page and the reference documentation.`;
  return new Response([header, ...entries.map(entry => pageMarkdown(entry, pages))].join("\n\n---\n\n"),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
