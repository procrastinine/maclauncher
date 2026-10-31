// Points download links at the MacLauncher build for the visitor's Mac. A link
// marked data-mac-build="detected" gets the matching build, and one marked
// "other" offers the remaining build. Plain links to either build, as in the
// Getting started text, download directly, and the one for this Mac is marked.
// Without a detected processor, the links keep their Apple Silicon default and
// the Intel alternative.
(() => {
  const base = "https://github.com/procrastinine/maclauncher/releases/latest/download/";
  const builds = {
    arm64: { asset: "MacLauncher.app.zip", name: "Apple Silicon" },
    x64: { asset: "MacLauncher-Intel.app.zip", name: "Intel" }
  };

  // Chromium reports the CPU directly. Elsewhere the WebGL renderer names the
  // GPU: Apple GPUs belong to Apple Silicon Macs, and Intel, AMD and NVIDIA
  // GPUs to Intel Macs. Safari reports every GPU as "Apple GPU"; there, ASTC
  // texture support, which only Apple Silicon GPUs provide on a Mac, decides.
  async function detect() {
    if (!/Macintosh|Mac OS X/.test(navigator.userAgent) || navigator.maxTouchPoints > 1) return null;
    try {
      const { architecture } = await navigator.userAgentData?.getHighEntropyValues(["architecture"]) || {};
      if (architecture === "arm") return "arm64";
      if (architecture === "x86") return "x64";
    } catch {}
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      if (!gl) return null;
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      const astc = gl.getSupportedExtensions()?.includes("WEBGL_compressed_texture_astc");
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      if (/Apple M\d|Apple A\d/i.test(renderer)) return "arm64";
      if (/Intel|AMD|Radeon|NVIDIA|GeForce/i.test(renderer)) return "x64";
      if (/Apple GPU/i.test(renderer)) return astc ? "arm64" : "x64";
    } catch {}
    return null;
  }

  function label(link, text) {
    const node = [...link.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.nodeValue.trim());
    if (node) node.nodeValue = node.nodeValue.replace(node.nodeValue.trim(), text);
  }

  // Plain links name their build by address.
  const plainLinks = () => [...document.querySelectorAll(`a[href^="${base}"]:not([data-mac-build])`)]
    .map(link => ({ link, key: Object.keys(builds).find(key => link.href === base + builds[key].asset) }))
    .filter(item => item.key);

  function apply(arch) {
    const other = arch === "x64" ? "arm64" : "x64";
    for (const link of document.querySelectorAll("a[data-mac-build]")) {
      const key = link.dataset.macBuild === "other" ? other : arch, build = builds[key];
      link.href = base + build.asset;
      link.setAttribute("download", build.asset);
      link.title = `MacLauncher for ${build.name} Macs`;
      const text = link.dataset[key === "x64" ? "labelX64" : "labelArm64"];
      if (text) label(link, text);
    }
    for (const { link, key } of plainLinks()) link.classList.toggle("thisMac", key === arch);
  }

  async function update() {
    for (const { link, key } of plainLinks()) link.setAttribute("download", builds[key].asset);
    const arch = await detect();
    if (arch) apply(arch);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", update, { once: true });
  else update();
})();
