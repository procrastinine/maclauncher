const fs = require("node:fs"), path = require("node:path");
const Components = require("../shared/runtime/runtime-components");
const Valve = require("./runtime/steam-client-components");

// Windows-side downloads without a Runtimes row; see core/component-service.js.
const store = userDataDir => path.join(userDataDir, "runtimes", "steam-client-components");
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const ARCHIVE = /^bins_misc_ubuntu12\.zip\.([a-f0-9]{40})$/;

module.exports = [
  {
    // Valve's genuine Windows client libraries, taken from the content-addressed
    // archive that Valve's client update manifest names.
    id: "steam-client-components",
    label: "Steam client components",
    description: "Valve's Windows steamclient.dll and steamclient64.dll. The Steam client bridge loads them so that Windows Steam games in CrossOver and Sikarugir talk to the Mac Steam client. They download with the bridge, after consent.",
    list({ userDataDir }) {
      const active = readJson(path.join(store(userDataDir), "active.json"));
      return Components.storeEntries(store(userDataDir), { match: /^[a-f0-9]{40}$/ }).map(directory => {
        const sha1 = path.basename(directory), current = active?.archiveSha1 === sha1;
        return { id: sha1, version: current ? "Current" : "Earlier archive", identity: `SHA-1 ${sha1}`, architecture: "Windows x86 + x64",
          path: directory, source: fs.existsSync(path.join(directory, ".manual")) ? "manual" : { url: current && /^https:\/\//.test(active.source || "") ? active.source : Valve.MANIFEST },
          users: current ? ["Steam client bridge (CrossOver, Sikarugir)"] : [] };
      });
    },
    async remove(item, { userDataDir }) {
      const active = path.join(store(userDataDir), "active.json");
      // A removed current archive leaves no active record, so the bridge asks to download one again.
      if (readJson(active)?.archiveSha1 === item.id) fs.rmSync(active, { force: true });
      return Components.removeOwned(item.path, store(userDataDir));
    },
    import: { label: "Add Valve client archive", kinds: ["file"],
      async run(file, { userDataDir, signal }) {
        const filename = path.basename(file), match = ARCHIVE.exec(filename);
        if (!match) throw new Error("Choose Valve's bins_misc_ubuntu12.zip.<SHA-1> archive. Its name carries the SHA-1 that identifies it.");
        const installed = await Valve.install({ userDataDir, signal, archiveFile: file,
          resolved: { filename, url: `${new URL(Valve.MANIFEST).origin}/${filename}` } });
        if (installed?.archiveSha1 !== match[1]) throw new Error("Another Valve client archive is current. Delete it first to use this one.");
        fs.writeFileSync(path.join(installed.root, ".manual"), "", { flag: "w" });
        return installed;
      } }
  },
  Components.fromRuntimeManager(require("./runtime/steam-bridge"), { users: ["Windows Steam games in CrossOver and Sikarugir"],
    description: "The MacLauncher package that connects Windows Steam games in CrossOver and Sikarugir to the Mac Steam client. Play offers it, after consent, for a Windows Steam game." }),
  Components.fromRuntimeManager(require("./runtime/winemac"), { users: ["CrossOver"],
    description: "An optional package matched to one CrossOver release and build. It adds Vulkan external memory, semaphore and fence sharing to CrossOver's Mac driver, and Play offers it, after consent, when that release runs a Vulkan game." }),
  ...Object.values(require("./temporal/support-manager").apiManagers).map(manager => Components.fromRuntimeManager(manager, {
    users: ["Graphics effects in CrossOver and Sikarugir games"],
    description: manager.id === "winevulkan-scene"
      ? "Adapted winevulkan modules that record a Windows game's Vulkan scene for graphics effects while forwarding its original calls."
      : "A proxy for a Windows game's FidelityFX library that keeps its exports and the original library's GPU work." }))
];
