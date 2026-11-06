const fs = require("node:fs"), path = require("node:path");
const File = require("../shared/runtime/pinned-file");
const Components = require("../shared/runtime/runtime-components");
const Rtp = require("./rtp");

// RGSS downloads without a Runtimes row; see core/component-service.js.
const packs = userDataDir => path.join(userDataDir, "modules", "rgss", "assets", "rtp-packs");
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

module.exports = [
  File.component(require("./soundfont").asset, { users: ["MKXP-Z (RPG Maker XP, VX and VX Ace games with MIDI music)"],
    description: "The General MIDI soundfont that MKXP-Z plays MIDI music with when no soundfont path is set in MKXP-Z settings." }),
  ...Rtp.catalog.packs.map(pack => ({
    id: `rgss-rtp:${pack.id}`, label: pack.label,
    description: `The publisher's ${pack.label} ${pack.version}, extracted once and shared by MKXP-Z games that declare it. The publisher's RTP terms apply.`,
    list({ userDataDir }) {
      const directory = path.join(packs(userDataDir), pack.id, pack.version), current = readJson(path.join(directory, "current.json"));
      if (!current || current.id !== pack.id) return [];
      return [{ id: pack.version, version: `${pack.version}`, identity: /^[a-f0-9]{64}$/.test(current.archiveSha256 || "") ? `SHA-256 ${current.archiveSha256}` : null,
        path: directory, source: current.manual ? "manual" : { url: current.sourceUrl || pack.sourceUrl }, users: [`MKXP-Z (games that declare ${pack.id})`] }];
    },
    remove(item, { userDataDir }) { return Components.removeOwned(item.path, packs(userDataDir)); },
    import: { label: `Add ${pack.label} installer`, kinds: ["file"], extensions: [path.extname(pack.archive.file).slice(1)].filter(Boolean),
      run: (file, context) => Rtp.installPack({ ...context, id: pack.id, archiveFile: file }) }
  }))
];
