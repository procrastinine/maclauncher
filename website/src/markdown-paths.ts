// Where the Markdown copies of the site live, relative to the site's base:
// each page at its own path plus ".md" (the home page at index.md), the whole
// site in llms-full.txt and an index of everything in llms.txt.
const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");
export const siteUrl = new URL(base, import.meta.env.SITE);

/** A docs entry's page name; the home page is "index". */
export const pageName = (id: string) => id === "" ? "index" : id;
export const markdownPath = (id: string) => `${pageName(id)}.md`;
export const htmlPath = (id: string) => pageName(id) === "index" ? "" : `${id}/`;
export const WHOLE_SITE = "llms-full.txt", INDEX = "llms.txt";

/** A path on this site, from its base. */
export const sitePath = (file: string) => `${base}${file}`;
