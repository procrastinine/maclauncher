// Valve's client listing at a fixed URL names the current client's archives.
// Each archive file is content addressed (its SHA-1 ends the name) with a
// size and SHA-256. Refresh reads only each archive's zip directory, in byte
// ranges, to find the one with both Windows client DLLs; its content address
// is the version. Valve lists only its current client.
const crypto = require("node:crypto");
const Components = require("../../src/modules/crossover/runtime/steam-client-files").components;

const sha1 = bytes => crypto.createHash("sha1").update(bytes).digest("hex");
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
// A stored zip whose central directory lists the given names.
function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = Buffer.from(name), data = Buffer.from(text), header = Buffer.alloc(30), entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, data); central.push(entry, nameBytes); offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
// An archive answers byte-range requests the way Valve's CDN does.
function ranges(bytes) {
  return (_url, options = {}) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range || "");
    if (!match) return { status: 200, headers: {}, body: bytes };
    const start = Number(match[1]), end = Math.min(Number(match[2]), bytes.length - 1);
    return { status: 206, headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` }, body: bytes.subarray(start, end + 1) };
  };
}
// The listing and its archives. Each archive is [family, files]; `extra` adds
// keys the listing does not use today.
function listing(version, archives, extra = "") {
  const routes = {}, blocks = archives.map(([family, files]) => {
    const bytes = zip(files), file = `${family}.zip.${sha1(bytes)}`;
    routes[`${Components.ORIGIN}/${file}`] = ranges(bytes);
    return `\t"${family}"\n\t{\n\t\t"file"\t\t"${file}"\n\t\t"size"\t\t"${bytes.length}"\n\t\t"sha2"\t\t"${sha256(bytes)}"\n${extra ? "\t\t\"futurefield\"\t\t\"1\"\n" : ""}\t}\n`;
  });
  routes[Components.MANIFEST] = `"ubuntu12"\n{\n\t"version"\t\t"${version}"\n${extra}${blocks.join("")}}\n`;
  return routes;
}
const clientFiles = archives => archives.find(([, files]) => files.some(([name]) => /steamclient64\.dll$/.test(name)))[1];
const clients = build => [["steamclient64.dll", "x64 client " + build], ["steamclient.dll", "x86 client " + build]];
const linux = build => ["bins_ubuntu12", [["ubuntu12_32/steamclient.so", "linux client " + build], ["ubuntu12_64/steamclient.so", "linux64 client " + build]]];
const windows = (build, family = "bins_win32_clients_all") => [family, clients(build)];
// The version Refresh lists: the content address of the archive with the DLLs.
const address = archives => sha1(zip(clientFiles(archives)));
const currentArchives = [linux("1731460212"), windows("1731460212")], nextArchives = [linux("1732000000"), windows("1732000000")];
const current = address(currentArchives);

module.exports = {
  managers: ["steam-client-components"],
  current: listing("1731460212", currentArchives),
  scenarios: {
    newVersion: { routes: listing("1732000000", nextArchives), version: address(nextArchives), usable: true, deleted: current },
    // The DLL archive renamed into another family.
    renamedArchive: { routes: listing("1732000000", [linux("1732000000"), windows("1732000000", "clients_windows_universal")]),
      version: address(nextArchives), usable: true, deleted: current },
    // More archives before the DLL archive, none of them with the clients.
    addedArchives: { routes: listing("1732000000", [["webkit_ubuntu12", [["webkit/libwebkit.so", "webkit"]]], linux("1732000000"),
      ["bins_codecs_all", [["codecs/avcodec.dll", "codec"], ["steamclient64.pdb", "symbols"]]], windows("1732000000")]),
    version: address(nextArchives), usable: true, deleted: current },
    // The client DLLs moved one folder deeper inside the archive.
    movedIntoFolder: { routes: listing("1732000000", [linux("1732000000"),
      ["bins_win32_clients_all", clients("1732000000").map(([name, text]) => ["windows/x86_64/" + name, text])]]),
    version: sha1(zip(clients("1732000000").map(([name, text]) => ["windows/x86_64/" + name, text]))), usable: true, deleted: current },
    // Keys and blocks the listing does not use today, at the top level and inside archives.
    unknownKeys: { routes: listing("1731460212", currentArchives, '\t"rollout"\n\t{\n\t\t"percent"\t\t"50"\n\t}\n'), version: current, usable: true }
  }
};
