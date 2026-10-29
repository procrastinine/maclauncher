// Each docs page as Markdown, at its own path plus ".md".
import type { APIRoute, GetStaticPaths } from "astro";
import { pageMarkdown, pageNames, sitePages } from "../markdown";
import { pageName } from "../markdown-paths";

export const getStaticPaths = (async () => {
  const entries = await sitePages(), pages = pageNames(entries);
  return entries.map(entry => ({ params: { page: pageName(entry.id) }, props: { markdown: pageMarkdown(entry, pages) } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(props.markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
