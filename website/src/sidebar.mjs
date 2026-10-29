// The site's navigation. Starlight renders it, and the Markdown copies of the
// site follow the same order.
export const sidebar = [
  { label: "Try the launcher", link: "/demo/" },
  { label: "Start here", items: ["introduction", "getting-started", "launcher"] },
  { label: "Background", items: ["background/how-games-run", "background/choosing-a-runtime"] },
  { label: "Games and runtimes", items: [{ autogenerate: { directory: "games" } }] },
  { label: "Graphics and effects", items: [{ autogenerate: { directory: "graphics" } }] },
  { label: "Tinker tools", items: [{ autogenerate: { directory: "tools" } }] },
  { label: "Help", items: ["help/faq"] },
  { label: "About", items: ["about/credits"] }
];
