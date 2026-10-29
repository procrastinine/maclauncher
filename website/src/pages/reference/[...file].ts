// The repository's reference documentation (docs/) as Markdown.
import type { APIRoute, GetStaticPaths } from "astro";
import { referenceFiles, referenceMarkdown } from "../../markdown";

export const getStaticPaths = (() => referenceFiles().map(file => ({ params: { file } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ params }) =>
  new Response(referenceMarkdown(String(params.file)), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
