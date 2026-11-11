const fs = require("node:fs");
const path = require("node:path");

// A Sikarugir Wine engine with the Template of support libraries published
// for it. The Template supplies the engine's translators and native libraries.
const support = install => install.templateRoot || install.supportRoot || path.join(install.installDir, "support");
module.exports = Object.freeze({
  id: "sikarugir", label: "Sikarugir", runtimeLabel: "Sikarugir", managerId: "sikarugir", invocation: "wine",
  order: 201, graphicsArchitecture: "x86_64",
  manager: () => require("../sikarugir/runtime/manager"),
  labels: Object.freeze({ source: "Sikarugir Template", automatic: "Sikarugir's automatic choice", environment: "Wrapper setting", environmentName: "Sikarugir wrapper" }),
  environmentKind: "sikarugir-wrapper",
  // Its Template includes the CNC-DDraw DirectDraw wrapper.
  directDraw: true, prefixModel: "windowsVersion", downloads: true,
  graphicsSelector: false,
  vulkanLibrarySelector: () => false,
  includedTranslators(install, add, { describe, source, requestedEngine, warnings, nativeRoots, result, Description }) {
    const { RELATIVE_PATHS, templateRenderers, gstreamerPaths } = require("../sikarugir/runtime/template-closure");
    const root = support(install), gstreamer = gstreamerPaths(root);
    add(gstreamer.plugins, "gstreamer", "video", { form: "dylib", frameworkRoot: gstreamer.root });
    // This is the same explicit DYLD root used by the launch.
    if (fs.existsSync(gstreamer.lib)) nativeRoots.push(gstreamer.lib);
    const rendererPath = fs.existsSync(path.join(root, RELATIVE_PATHS.renderers)) ? RELATIVE_PATHS.renderers : templateRenderers(root, install.templateVersion);
    const renderers = rendererPath && path.join(root, rendererPath);
    if (renderers) for (const name of fs.readdirSync(renderers).sort()) {
      const engine = /^(?:dxvk|d9vk)/.test(name) ? "dxvk" : name;
      if (["dxmt", "dxvk", "d3dmetal", "cnc_ddraw"].includes(engine)) add(path.join(renderers, name), engine, "d3d-renderer", { templateComponent: name, hiddenChoice: engine === "cnc_ddraw" });
    }
    const vulkan = path.join(root, RELATIVE_PATHS.vulkan);
    if (fs.existsSync(vulkan)) for (const name of fs.readdirSync(vulkan).filter(name => name.endsWith(".json"))) {
      const engine = /kosmickrisp/i.test(name) ? "kosmickrisp" : /moltenvk/i.test(name) ? "moltenvk" : null;
      if (requestedEngine && engine !== requestedEngine) continue;
      try {
        const descriptor = JSON.parse(fs.readFileSync(path.join(vulkan, name), "utf8")), library = path.resolve(vulkan, descriptor.ICD.library_path);
        if (engine) {
          const before = result.length; add(library, engine, "vulkan-driver", { form: "icd" });
          if (result.length > before) {
            const description = result.at(-1); description.icd = path.join(vulkan, name);
            const relative = path.join(RELATIVE_PATHS.frameworks, "libvulkan.1.dylib"), loader = path.join(root, relative);
            if (fs.existsSync(loader)) {
              const file = describe ? describe(loader, { engine, component: "vulkan-driver", source, form: "dylib" })?.files[0] : Description.inspectFile({ path: loader, relative });
              if (file) description.files.push({ ...file, relative });
            }
          }
        }
      } catch (error) { warnings.push(error.message); }
    }
  },
  // The Template's DXMT, for a Wine tree with the modern WoW64 layout.
  dxmtBase(install) {
    const engine = install.engineRoot || install.wineRoot || (install.executablePath && path.dirname(path.dirname(install.executablePath)));
    if (!engine || !fs.existsSync(path.join(engine, "lib/wine/x86_64-unix/ntdll.so")) || fs.existsSync(path.join(engine, "lib/wine/x86_32on64-unix/ntdll.so"))) return null;
    return path.join(support(install), "Frameworks/renderer/dxmt/wine");
  },
  nativeLibraries(install) {
    const root = support(install), frameworks = path.join(root, "Frameworks");
    const gstreamer = require("../sikarugir/runtime/template-closure").gstreamerPaths(root);
    return { libraries: [frameworks], frameworks: [frameworks],
      gstreamer: fs.existsSync(gstreamer.lib) ? { lib: gstreamer.lib, plugins: gstreamer.plugins, scanner: gstreamer.scanner } : null };
  },
  // The publisher's Wine 11 loader requires this initialization marker before
  // loading Windows libraries, including wineboot in a fresh prefix.
  launchEnvironment: (install, { existingEnvironment } = {}) => existingEnvironment || /^11(?:[._]|$)/.test(install.engineVersion || "") ? { SikarugirAppWine11: "1" } : {}
});
