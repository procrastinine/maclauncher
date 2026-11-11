// The site's navigation. Starlight renders it, and the Markdown copies of the
// site follow the same order. The groups follow the README's three roles; a
// group can list pages from any directory, so page URLs stay where they are.
export const sidebar = [
  { label: "Try the launcher", link: "/demo/" },
  { label: "Start here", items: ["introduction", "getting-started", "macs-and-macos", "launcher"] },
  {
    label: "Native runtimes",
    items: [
      "games", "background/how-games-run", "background/choosing-a-runtime",
      "games/desktop-engines", "games/visual-novels", "games/windows", "games/mobile-and-consoles", "games/more",
      { label: "MacLauncher Builds packages", link: "https://procrastinine.github.io/maclauncher-builds/" }
    ]
  },
  {
    label: "Windows games and WINE",
    items: [
      "windows", "windows/crossover-and-sikarugir", "windows/existing-bottles", "windows/choosing-a-translator",
      "windows/settings", "windows/effects-and-upscaling"
    ]
  },
  { label: "Graphics and effects", items: [{ autogenerate: { directory: "graphics" } }] },
  {
    label: "Patch and tinker tools",
    items: [
      "tools", "tools/runtime-patching", "windows/graphics-translators", "windows/translator-versions", "windows/kosmickrisp",
      "tools/stores-and-downloads", "windows/steam-client-bridge", "tools/versions-and-settings", "tools/patching-games",
      "tools/saves-and-cheats", "tools/decompilers-and-extractors", "tools/network-and-privacy"
    ]
  },
  { label: "Help", items: ["help/faq"] },
  { label: "About", items: ["about/credits"] }
];
