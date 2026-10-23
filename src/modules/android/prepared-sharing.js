const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../shared/writable-input");
const {withCatalogLock, acquireCatalogLock} = require("./catalog-lock");

const digest = value => /^[a-f0-9]{64}$/.test(value || "");
const generation = name => /^[a-f0-9]{64}(?:-[a-f0-9]{16})?$/.test(name);
const macho = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs].join(":");
const inode = stat => [stat.dev, stat.ino].join(":");
const nativeName = name => /^input\/lib\/(?:arm64-v8a|armeabi-v7a|armeabi)\/[^/]+\.so$/.test(name);
const MIN_HINT_BYTES = 64 * 1024, MAX_HINTS = 8192, MAX_INDEX_BYTES = 8 * 1024 ** 2;

function location(directory) {
  const android = path.resolve(directory, "../../..");
  if (path.basename(directory) !== "prepared" || path.basename(path.dirname(path.dirname(directory))) !== "apps" ||
      !/^[\w-]{1,128}$/.test(path.basename(path.dirname(directory)))) return null;
  return {android, file: path.join(android, ".prepared-content.json"), lock: path.join(android, ".prepared-content.lock")};
}
function readIndex(where) {
  try {
    const stat = fs.lstatSync(where.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > MAX_INDEX_BYTES) return {};
    const value = JSON.parse(fs.readFileSync(where.file, "utf8"));
    return value?.schemaVersion === 1 ? value : {};
  } catch { return {}; }
}
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const readHints = where => object(readIndex(where).entries);
function writeIndex(where, index) {
  const entries = Object.entries(object(index.entries)).filter(([key]) => digest(key)).slice(-MAX_HINTS);
  const aliases = Object.entries(object(index.nativeAliases)).filter(([key]) => /^\d+:\d+$/.test(key)).slice(-MAX_HINTS);
  let bytes;
  do {
    bytes = JSON.stringify({schemaVersion: 1, entries: Object.fromEntries(entries), nativeAliases: Object.fromEntries(aliases)});
    if (Buffer.byteLength(bytes) <= MAX_INDEX_BYTES) break;
    // Both collections are recoverable metadata. Keep the newest membership
    // (the one being published), without creating a second content store.
    if (entries.length) entries.shift(); else if (aliases.length > 1) aliases.shift(); else return false;
  } while (true);
  Writable.atomicWrite(where.file, bytes, {root: where.android});
  return true;
}
function hint(where, row) {
  if (!row || typeof row.root !== "string" || typeof row.name !== "string") return null;
  const parts = row.root.split("/");
  if (parts.length !== 4 || parts[0] !== "apps" || !/^[\w-]{1,128}$/.test(parts[1]) || parts[2] !== "prepared" || !generation(parts[3]) ||
      !inputs({schemaVersion: 2, sourceName: row.name, apkSha256: "a".repeat(64), execution: "art", files: []}).length ||
      !(row.name === "converted.jar" || /^[\w.-]+\.apk$/.test(row.name) || row.name.startsWith("input/assets/") || row.name.startsWith("input/lib/"))) return null;
  return {root: path.join(where.android, ...parts), name: row.name};
}
const rowFor = (where, root, name) => ({root: path.relative(where.android, root).split(path.sep).join("/"), name});
const rowKey = row => row.root + "/" + row.name;
function rememberNative(index, stat, sha256, members, replace = false) {
  const aliases = object(index.nativeAliases), key = inode(stat), previous = aliases[key];
  const rows = !replace && previous?.identity === identity(stat) && previous.sha256 === sha256 && Array.isArray(previous.members) ?
    previous.members.filter(row => row && typeof row.root === "string" && typeof row.name === "string") : [];
  const unique = new Map([...rows, ...members].map(row => [rowKey(row), row]));
  delete aliases[key]; // Refresh insertion order for bounded cache retention.
  aliases[key] = {identity: identity(stat), sha256, members: [...unique.values()]};
  index.nativeAliases = aliases;
}

async function publishedNative(where, row, sha256) {
  const member = hint(where, row);
  if (!member || !nativeName(member.name)) return null;
  // Check every ancestor from the owned profile root, including the package
  // and generation. A receipt or a matching hash cannot authenticate an alias.
  Writable.assertOwnDirectory(where.android, path.dirname(path.join(member.root, member.name)), {create: false});
  const receiptFile = path.join(member.root, "prepared.json"), stat = await fs.promises.lstat(receiptFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.size > 16 * 1024 ** 2) return null;
  const receipt = JSON.parse(await fs.promises.readFile(receiptFile, "utf8"));
  if (receipt.key !== path.basename(member.root).slice(0, 64) || !digest(receipt.apkSha256) ||
      !inputs(receipt).some(item => item.name === member.name && item.sha256 === sha256)) return null;
  const file = await regular(where.android, path.relative(where.android, path.join(member.root, member.name)));
  if (!file || file.stat.uid !== BigInt(process.getuid()) || await fs.promises.realpath(file.file) !== file.file) return null;
  return file;
}

async function membersFor(where, index, stat, sha256, signal, recover = true) {
  const known = object(index.nativeAliases)[inode(stat)], members = new Map();
  async function inspect(row) {
    signal?.throwIfAborted();
    let file; try { file = await publishedNative(where, row, sha256); } catch { return; }
    if (file && identity(file.stat) === identity(stat)) members.set(file.file, row);
  }
  if (known?.identity === identity(stat) && known.sha256 === sha256 && Array.isArray(known.members))
    for (const row of known.members) await inspect(row);
  if (BigInt(members.size) === stat.nlink || !recover) return members;
  // Legacy indexes kept only two hints. Recover solely from published owned
  // generation receipts, never from app data, raw imports or filesystem scans.
  const apps = path.join(where.android, "apps");
  for (const app of await fs.promises.readdir(apps, {withFileTypes: true})) {
    if (!app.isDirectory() || app.isSymbolicLink() || !/^[\w-]{1,128}$/.test(app.name)) continue;
    const directory = path.join(apps, app.name, "prepared");
    let generations; try { Writable.assertOwnDirectory(where.android, directory, {create: false}); generations = await fs.promises.readdir(directory, {withFileTypes: true}); } catch { continue; }
    for (const entry of generations) {
      signal?.throwIfAborted();
      if (!entry.isDirectory() || entry.isSymbolicLink() || !generation(entry.name)) continue;
      const root = path.join(directory, entry.name), receiptFile = path.join(root, "prepared.json");
      let receipt;
      try {
        const metadata = await fs.promises.lstat(receiptFile);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || metadata.size > 16 * 1024 ** 2) continue;
        receipt = JSON.parse(await fs.promises.readFile(receiptFile, "utf8"));
        if (receipt.key !== entry.name.slice(0, 64) || !digest(receipt.apkSha256)) continue;
      } catch { continue; }
      for (const item of inputs(receipt)) if (nativeName(item.name) && item.sha256 === sha256)
        await inspect(rowFor(where, root, item.name));
      if (BigInt(members.size) === stat.nlink) return members;
    }
  }
  return members;
}

/** Complete shared-inode proof under the same owner as link publication.
 * Only the caller's selected exact files become execution capabilities. */
async function executableAliases(file, handle, stat, writable, signal) {
  const root = path.resolve(path.dirname(file), "../../.."), where = location(path.dirname(root));
  if (!where || !nativeName(path.relative(root, file).split(path.sep).join("/"))) return new Set();
  return withCatalogLock(where.lock, async () => {
    const index = readIndex(where), selected = rowFor(where, root, path.relative(root, file).split(path.sep).join("/"));
    // The receipt identifies the expected original bytes; index entries alone
    // are never sufficient, even when all their inode numbers match.
    let sha256;
    try {
      const receiptFile = path.join(root, "prepared.json"), metadata = fs.lstatSync(receiptFile);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || metadata.size > 16 * 1024 ** 2) return new Set();
      const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
      if (receipt.key !== path.basename(root).slice(0, 64) || !digest(receipt.apkSha256)) return new Set();
      sha256 = inputs(receipt).find(item => item.name === selected.name)?.sha256;
    } catch { return new Set(); }
    if (!digest(sha256)) return new Set();
    const members = await membersFor(where, index, stat, sha256, signal);
    if (!members.has(file) || BigInt(members.size) !== stat.nlink || [...members.keys()].some(alias =>
      writable.some(directory => alias === directory || alias.startsWith(directory + path.sep)))) return new Set();
    const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(256 * 1024);
    for (let offset = 0; offset < Number(stat.size);) {
      signal?.throwIfAborted();
      const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.length, Number(stat.size) - offset), offset);
      if (!bytesRead) return new Set();
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    if (hash.digest("hex") !== sha256) return new Set();
    for (const alias of members.keys()) {
      let current;
      try {
        Writable.assertOwnDirectory(where.android, path.dirname(alias), {create: false});
        if (await fs.promises.realpath(alias) !== alias) return new Set();
        current = await fs.promises.lstat(alias, {bigint: true});
      } catch { return new Set(); }
      if (!current.isFile() || current.isSymbolicLink() || identity(current) !== identity(stat) || current.nlink !== stat.nlink) return new Set();
    }
    const after = await handle.stat({bigint: true});
    if (identity(after) !== identity(stat) || after.nlink !== stat.nlink || after.ctimeNs !== stat.ctimeNs) return new Set();
    rememberNative(index, after, sha256, [...members.values()], true); writeIndex(where, index);
    return new Set(members.keys());
  });
}
async function remember(where, destination, receipt, signal) {
  if (!where) return;
  const rows = [];
  for (const item of inputs(receipt)) {
    signal?.throwIfAborted();
    if (Number.isSafeInteger(item.bytes) && item.bytes < MIN_HINT_BYTES) continue;
    let file; try { file = await regular(destination, item.name); } catch { continue; }
    if (!file || file.stat.size < MIN_HINT_BYTES || await isMachO(file.file)) continue;
    rows.push([item.sha256, {root: path.relative(where.android, destination).split(path.sep).join("/"), name: item.name}]);
  }
  await withCatalogLock(where.lock, async () => {
    const index = readIndex(where), entries = object(index.entries);
    for (const [sha256, row] of rows) {
      const before = Array.isArray(entries[sha256]) ? entries[sha256].filter(value => hint(where, value)) : [];
      entries[sha256] = [row, ...before.filter(value => value.root !== row.root || value.name !== row.name)].slice(0, 2);
    }
    index.entries = entries; writeIndex(where, index);
  });
}

// Only published code inputs participate. Receipts, leases, app data and raw
// imports never share an inode. Hardlinks remain valid when an older generation
// retires, without a second blob store or a separate garbage collector.
function inputs(receipt) {
  if (![1, 2].includes(receipt?.schemaVersion) || !Array.isArray(receipt.files) || receipt.sources && !Array.isArray(receipt.sources)) return [];
  const files = [...(receipt.sources || [{name: receipt.sourceName || "source.apk", sha256: receipt.apkSha256}]),
    ...(receipt.execution === "art" ? [] : [{name: "converted.jar", sha256: receipt.convertedSha256}]),
    ...receipt.files.filter(item => item && typeof item.name === "string" && (receipt.execution !== "art" || !item.name.startsWith("assets/")))
      .map(item => ({...item, name: "input/" + item.name}))];
  return files.filter(item => item && digest(item.sha256) && typeof item.name === "string" &&
    !item.name.includes("\\") && !item.name.includes("\0") &&
    item.name.split("/").every(part => part && part !== "." && part !== "..") && !path.isAbsolute(item.name));
}

async function regular(root, name) {
  const file = path.join(root, name);
  Writable.assertOwnDirectory(root, path.dirname(file), {create: false});
  const stat = await fs.promises.lstat(file, {bigint: true});
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  return {file, stat};
}

async function isMachO(file) {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const bytes = Buffer.alloc(4), result = await handle.read(bytes, 0, 4, 0); return result.bytesRead === 4 && macho.has(bytes.readUInt32BE()); }
  finally { await handle.close(); }
}

/** Caller holds the package preparation lock; destination has no live reader. */
async function shareInputs(directory, destination, receipt, {hashFile, signal} = {}) {
  if (typeof hashFile !== "function") throw new TypeError("Prepared sharing requires verified file hashes");
  Writable.assertOwnDirectory(directory, destination, {create: false});
  const candidates = new Map(), result = {linkedFiles: 0, sharedBytes: 0}, where = location(directory), releases = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !generation(entry.name)) continue;
    const root = path.join(directory, entry.name);
    if (root === destination) continue;
    let other;
    try {
      const file = path.join(root, "prepared.json"), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 ** 2) continue;
      other = JSON.parse(fs.readFileSync(file, "utf8"));
      if (other.key !== entry.name.slice(0, 64)) continue;
    } catch { continue; }
    for (const item of inputs(other)) {
      const rows = candidates.get(item.sha256) || [];
      rows.push({root, name: item.name}); candidates.set(item.sha256, rows);
    }
  }
  // The index holds bounded candidate hints and complete native alias groups,
  // never a second byte copy.
  // Foreign preparation locks are nonblocking: unrelated games cannot form a
  // lock cycle, and busy/stale candidates are ordinary sharing misses.
  if (where) {
    const hints = readHints(where), foreign = new Map();
    for (const item of inputs(receipt)) for (const row of Array.isArray(hints[item.sha256]) ? hints[item.sha256] : []) {
      const value = hint(where, row); if (!value || path.dirname(value.root) === directory) continue;
      const lock = path.join(path.dirname(path.dirname(value.root)), ".preparation.lock");
      const rows = foreign.get(lock) || []; rows.push({sha256: item.sha256, ...value}); foreign.set(lock, rows);
    }
    for (const [lock, rows] of foreign) {
      let release; try { release = await acquireCatalogLock(lock, {wait: false}); } catch { continue; }
      if (!release) continue; releases.push(release);
      for (const {sha256, ...row} of rows) { const values = candidates.get(sha256) || []; values.push(row); candidates.set(sha256, values); }
    }
  }
  try {
  for (const item of inputs(receipt)) {
    signal?.throwIfAborted();
    const rows = candidates.get(item.sha256); if (!rows) continue;
    let target; try { target = await regular(destination, item.name); } catch { continue; }
    if (!target || await isMachO(target.file)) continue;
    let verified = false;
    for (const row of rows) {
      signal?.throwIfAborted();
      let source;
      try { source = await regular(row.root, row.name); } catch { continue; }
      if (!source || source.stat.dev !== target.stat.dev || source.stat.size !== target.stat.size || source.stat.mode !== target.stat.mode) continue;
      if (source.stat.ino === target.stat.ino) break;
      // Same hashes in receipts are only an index. Verify actual bytes before
      // replacing either inode; corrupted/edited caches cannot supply inputs.
      if (!verified) { if (await hashFile(target.file, signal) !== item.sha256) break; verified = true; }
      try { if (await hashFile(source.file, signal) !== item.sha256) continue; }
      catch (error) { if (signal?.aborted) throw error; continue; }
      if (identity(await fs.promises.lstat(source.file, {bigint: true})) !== identity(source.stat) ||
          identity(await fs.promises.lstat(target.file, {bigint: true})) !== identity(target.stat)) continue;
      const temporary = target.file + ".share-" + crypto.randomBytes(12).toString("hex");
      try {
        const publish = async () => {
          let index, members;
          const current = await fs.promises.lstat(source.file, {bigint: true});
          if (identity(current) !== identity(source.stat)) return false;
          // Another publication may have added a safe alias since hashing.
          // Link-count/ctime changes do not change the verified source bytes.
          source.stat = current;
          if (where && nativeName(item.name)) {
            if (!nativeName(row.name)) return false;
            index = readIndex(where);
            // Preserve the complete source group before adding a new member.
            // Unknown foreign links cannot become trusted through deduplication.
            rememberNative(index, source.stat, item.sha256, [rowFor(where, row.root, row.name)]);
            members = await membersFor(where, index, source.stat, item.sha256, signal);
            if (BigInt(members.size) !== source.stat.nlink) return false;
          }
          if (identity(await fs.promises.lstat(source.file, {bigint: true})) !== identity(source.stat) ||
              identity(await fs.promises.lstat(target.file, {bigint: true})) !== identity(target.stat)) return false;
          await fs.promises.link(source.file, temporary);
          const linked = await fs.promises.lstat(temporary, {bigint: true});
          if (!linked.isFile() || identity(linked) !== identity(source.stat)) throw new Error("An Android preparation changed during sharing.");
          signal?.throwIfAborted();
          await fs.promises.rename(temporary, target.file);
          if (members) {
            rememberNative(index, linked, item.sha256, [...members.values(), rowFor(where, destination, item.name)], true);
            writeIndex(where, index);
          }
          result.linkedFiles++; result.sharedBytes += Number(linked.size); return true;
        };
        if (await (where && nativeName(item.name) ? withCatalogLock(where.lock, publish) : publish())) break;
      } catch (error) { if (!["EXDEV", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOENT", "ESTALE"].includes(error.code)) throw error; }
      finally { await fs.promises.rm(temporary, {force: true}); }
    }
  }
  await remember(where, destination, receipt, signal);
  return result;
  } finally { for (const release of releases.reverse()) await release(); }
}

module.exports = {inputs, shareInputs, executableAliases};
