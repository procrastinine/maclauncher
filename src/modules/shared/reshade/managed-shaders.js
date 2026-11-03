const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { cloneOrCopySync } = require("../copy-file");
const Catalog = require("./managed-shader-packs.json"), Traits = require("./shader-traits"), Providers = require("./shader-providers");
const Writable = require("../writable-input"), Native = require("../runtime/local-native"), Items = require("../item-results");
const Zip = require("../runtime/zip"), Upstream = require("../runtime/upstream"), Release = require("../runtime/release-files");
const Downloads = { throwIfAborted: require("../runtime/download-utils").throwIfAborted }, { runDownloadTask } = require("../runtime/download-manager");
const { confirmToolInstall } = require("../runtime/tool-install");
const { withRuntimeMutation } = require("../../../core/coordinated-runtime-managers");
const customCollections = new Map();
const entryLists = new Map();
const ID = "graphics-shader-library", LIMITS = { archive: 64 << 20, expanded: 256 << 20, file: 8 << 20, entries: 4096, versions: 64 };
const formats = Object.fromEntries(Providers.sourceExtensions.map(extension=>[extension,Providers.sourceFormat("effect"+extension)]));
const safe = value => typeof value === "string" && value.length > 0 && value.length < 1024 && !path.posix.isAbsolute(value) &&
  !/[\\\x00-\x1f]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");
const version = value => { if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value || "")) throw new Error("Invalid shader pack version."); return value; };
function sourceVersion(pack,commit,adaptationVersion=pack.sourceOverlay?.version){
  return "git-"+commit+(adaptationVersion?"-mcl"+adaptationVersion:"");
}
function sourceOverlayFor(pack,row){
  if(!pack.sourceOverlay)return null;
  const recipe=pack.sourceOverlay.recipes?.[row.adaptationVersion];
  if(typeof recipe!=="string"||!safe(recipe)||!recipe.endsWith(".js"))throw Error("The shader collection source recipe is unavailable for this version.");
  const implementation=require("./"+recipe);
  if(typeof implementation.apply!=="function"||!Array.isArray(implementation.sourceFiles)||!implementation.sourceFiles.length||
      implementation.sourceFiles.length>LIMITS.entries||implementation.sourceFiles.some(file=>!safe(file)))throw Error("The shader collection source recipe is invalid.");
  return implementation;
}
const packFor = id => { const pack = Catalog.packs.find(row => row.id === id); if (!pack) throw new Error("Unknown shader pack."); return pack; };
// Pickers list collection shaders under the collection's name, which stays
// distinct from included shaders taken from the same project.
const collectionLabel = label => /collection$/i.test(label) ? label : label + " collection";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const verified = new Map(), pending = new Map(), states = new Map();
function directory(userDataDir, packId) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("Shader packs require the launcher's data directory.");
  if (packId) packFor(packId);
  return path.join(userDataDir, "runtimes", ID, ...(packId ? [packId] : []));
}
function installRoot(userDataDir, packId, selected) { return path.join(directory(userDataDir, packId), version(selected)); }
function isId(id) { return /^shader:managed-[a-z0-9]+(?:-[a-z0-9]+)*:[a-f0-9]{16}$/.test(id || ""); }
function parseId(id) {
  if (!isId(id)) throw new Error("Unknown managed shader.");
  const match = /^shader:managed-(.+):([a-f0-9]{16})$/.exec(id);
  return { pack: packFor(match[1]), effect: match[2] };
}
function validRow(pack, row) {
  try {
    version(row.version);
    if (row.commit && !/^[a-f0-9]{40}$/.test(row.commit)) return false;
    if (pack.delivery !== "release-zip") return row.version === sourceVersion(pack,row.commit,row.adaptationVersion)&&
      (!pack.sourceOverlay||Number.isSafeInteger(row.adaptationVersion)&&row.adaptationVersion>0&&row.adaptationVersion<=999);
    const url = new URL(row.archive.url);
    return typeof row.tag === "string" && row.tag.length < 100 && url.protocol === "https:" && url.hostname === "github.com" &&
      url.pathname.startsWith(`/${pack.repository}/releases/download/`) && !url.search && !url.hash &&
      new RegExp(pack.assetPattern, "i").test(path.posix.basename(url.pathname)) && Release.archiveFormat(path.posix.basename(url.pathname)) &&
      Number.isSafeInteger(row.archive.bytes) && row.archive.bytes > 0 && row.archive.bytes <= LIMITS.archive &&
      (!row.archive.sha256 || /^[a-f0-9]{64}$/.test(row.archive.sha256));
  } catch { return false; }
}
function cached(userDataDir, packId) {
  try {
    const pack = packFor(packId), file = path.join(directory(userDataDir, packId), "catalog.json"), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > (2 << 20)) return null;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record.repository !== pack.repository || !Array.isArray(record.entries) || record.entries.length > LIMITS.versions ||
      record.entries.some(row => !validRow(pack, row))) return null;
    return record;
  } catch { return null; }
}
// Status reads the local list; Refresh or a consented install discovers versions.
function available(userDataDir, packId) {
  packFor(packId);
  return [...(cached(userDataDir, packId)?.entries || [])].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) ||
    b.version.localeCompare(a.version, "en", { numeric: true }));
}
function installed(userDataDir, packId, selected, full = false) {
  try {
    const root = installRoot(userDataDir, packId, selected), file = path.join(root, "pack.json");
    Writable.assertOwnDirectory(userDataDir, root, { create: false });
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > (4 << 20)) return null;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record.schema !== 1 || record.packId !== packId || record.version !== selected || !validRow(packFor(packId), record.source) ||
      !Array.isArray(record.effects) || !record.effects.length || record.effects.length > LIMITS.entries || !record.files ||
      Object.keys(record.files).length > LIMITS.entries || record.effects.some(row => !safe(row.file) ||
        !formats[path.extname(row.file).toLowerCase()] || row.id !== record.files[row.file]?.sha256?.slice(0, 16))) return null;
    if(packFor(packId).sourceOverlay&&record.sourceOverlay?.version!==record.source.adaptationVersion)return null;
    if (full) {
      const identities = [];
      for (const [relative, item] of Object.entries(record.files)) {
        if (!safe(relative) || !/^[a-f0-9]{64}$/.test(item.sha256 || "") || !Number.isSafeInteger(item.bytes) || item.bytes > LIMITS.file) return null;
        const child = path.join(root, "files", relative), childStat = fs.lstatSync(child);
        if (!childStat.isFile() || childStat.isSymbolicLink() || childStat.size !== item.bytes || fs.realpathSync(child) !== child) return null;
        identities.push([relative, childStat.ino, childStat.size, childStat.mtimeMs, childStat.ctimeMs]);
      }
      const identity = JSON.stringify([stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, identities]);
      if (verified.get(root) !== identity) {
        for (const [relative, item] of Object.entries(record.files)) if (Native.hashFile(path.join(root, "files", relative)) !== item.sha256) return null;
        if (verified.size > 128) verified.delete(verified.keys().next().value);
        verified.set(root, identity);
      }
    }
    return { ...record, root, installDir: root, ready: true, removable: true, sectionId: packId,
      versionLabel: record.source.tag || record.source.date?.slice(0, 10) + " · " + record.source.commit?.slice(0, 8) || selected };
  } catch { return null; }
}
function listInstalled(userDataDir, packId) {
  if (!packId) return Catalog.packs.flatMap(pack => listInstalled(userDataDir, pack.id));
  try { return fs.readdirSync(directory(userDataDir, packId)).filter(name => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name))
    .slice(0, LIMITS.versions).map(selected => installed(userDataDir, packId, selected)).filter(Boolean)
    .sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt))); } catch { return []; }
}
function selectedInstalls(userDataDir, packId, options = {}) {
  const records = module.exports.listInstalled(userDataDir, packId);
  // Explicit caller selections stay pinned. The library default only chooses
  // between copies of the same stable, content-addressed shader ID.
  if (options.packVersion !== undefined) return records.filter(record => record.version === module.exports.normalizeVersion(options.packVersion));
  const preferred = options.settings?.runtimes?.[ID]?.defaultVersions?.[packId];
  return [...records.filter(record => record.version === preferred), ...records.filter(record => record.version !== preferred)];
}
function availability(effect, features, options = {}) {
  const nativeVideo = options.nativeVideo === true || features?.nativeVideo === true;
  const traits = options.traits || effect.traits || {};
  const historyReason=Providers.traitsAvailability(effect.format,traits,{features});if(historyReason)return historyReason;
  if (traits.requiresVideoPlanes && !traits.derivedPlaneCompatible && !nativeVideo) return "Requires native video source metadata.";
  if (traits.requiresDerivedPlanes && !nativeVideo && features?.providers?.libplacebo?.derivedPlanes !== true)
    return "The installed shader processor does not provide derived luma and chroma planes.";
  if(traits.libplaceboImageFilter&&features?.providers?.libplacebo?.imageFiltersAPI!==1)return "The installed libplacebo provider does not include this image filter.";
  return nativeVideo && effect.format === "libplacebo" && traits.sharedOnly!==true && !Object.keys(traits.sceneBindings||{}).length ? null : Providers.availability(effect.format, { ...options, features });
}
function effectTraits(record, effect) {
  if (effect.traitsVersion === Traits.VERSION && !["slang","slangp","fx"].includes(effect.format)) return effect.traits;
  const traits = Traits.analyzeFile(path.join(record.filesRoot || path.join(record.root, "files"), effect.file), effect.format).traits;
  return traits;
}
function effectEntries(record){
  const key=hash(JSON.stringify([Traits.VERSION,record.root,record.filesRoot,record.files,record.effects]));
  if(entryLists.has(key))return entryLists.get(key);
  const pack=packFor(record.packId),labels=new Map((pack.entrypoints||[]).map(row=>[row.file,row.label])),byFile=new Map(record.effects.map(row=>[row.file,row])),seen=new Set(),result=[];
  // The immutable inventory already contains all shipped sources. Old copies
  // may have recorded only recommendations in effects; expose the remaining
  // declared shader files without changing that package or downloading again.
  for(const file of [...byFile.keys(),...Object.keys(record.files)]){
    const item=record.files[file],format=formats[path.extname(file).toLowerCase()];
    if(!safe(file)||!format||!/^[a-f0-9]{64}$/.test(item?.sha256||""))continue;
    const id=item.sha256.slice(0,16);if(seen.has(id))continue;
    const existing=byFile.get(file);
    if(format==="magpie"&&!existing){
      try{if(!/^\s*\/\/!MAGPIE EFFECT\s*$/m.test(fs.readFileSync(path.join(record.filesRoot||path.join(record.root,"files"),file),"utf8")))continue;}catch{continue;}
    }
    result.push(existing?{...existing,...(labels.has(file)?{recommended:true}:{})}:
      {id,file,format,label:labels.get(file)||pathLabel(file),traitsVersion:0,traits:{},recommended:labels.has(file),nativeVideo:format==="libplacebo"&&Boolean(pack.videoPaths?.some(prefix=>file.startsWith(prefix)))});
    seen.add(id);
  }
  const names=displayNames(result.map(row=>row.file));
  for(const [index,row] of result.entries())if(!labels.has(row.file)&&(!row.label||row.label===pathLabel(row.file)))result[index]={...row,label:names.get(row.file)};
  if(entryLists.size>=64)entryLists.delete(entryLists.keys().next().value);entryLists.set(key,result);return result;
}
const pathLabel=file=>file.replace(/\.[^./]+$/,"").replace(/_/g," ");
// A file without a declared label is named after its file, keeping only the
// parent directories needed to tell apart files of the same name.
function displayNames(files){
  const parts=files.map(file=>pathLabel(file).split("/")),depth=parts.map(()=>1),name=index=>parts[index].slice(-depth[index]).join("/");
  for(let changed=true;changed;){
    changed=false;const counts=new Map();
    for(const index of parts.keys())counts.set(name(index),(counts.get(name(index))||0)+1);
    for(const index of parts.keys())if(counts.get(name(index))>1&&depth[index]<parts[index].length){depth[index]++;changed=true;}
  }
  return new Map(files.map((file,index)=>[file,name(index)]));
}
function listEffects(userDataDir, features = {}, options = {}) {
  return Traits.withMetadataSnapshot(() => listEffectSnapshot(userDataDir, features, options));
}
// One effect, or one installed copy, that cannot be read is listed as
// unavailable with its reason; the other effects stay listed.
function listEffectSnapshot(userDataDir, features, options) {
  const seen = new Set(), records = Catalog.packs.flatMap(pack => selectedInstalls(userDataDir, pack.id, options));
  const unreadable = ({id, reason}, label) => ({id, label, group: label, available: false, reason, installed: true, bundled: false});
  const copies = Items.settle(records, record => effectEntries(record).map(effect => ({record, effect})), {id: record => record.packId});
  const effects = Items.settle(copies.results.flat(), ({record, effect}) => listedEffect(record, effect),
    {id: ({record, effect}) => `shader:managed-${record.packId}:${effect.id}`});
  return [...effects.results.flat(), ...effects.failures.map(row => unreadable(row, row.id)),
    ...copies.failures.map(row => unreadable({...row, id: `shader:managed-${row.id}`}, packFor(row.id)?.label || row.id))];
  function listedEffect(record, effect) {
    const id = `shader:managed-${record.packId}:${effect.id}`;
    if (seen.has(id)) return []; seen.add(id);
    let reason, nativeVideoAvailable = effect.format === "libplacebo";
    const file = path.join(record.filesRoot || path.join(record.root, "files"), effect.file);let traits = effect.traits || {},sourceRevision;
    try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
      if(["fx","slang","slangp"].includes(effect.format)){const analysis=Traits.analyzeFile(file,effect.format);traits=analysis.traits;sourceRevision=analysis.sourceRevision;}
      else {traits=effectTraits(record,effect);sourceRevision=Traits.sourceRevision(null,stat);} }
    catch { reason = "The installed shader file is missing. Reinstall this shader pack."; nativeVideoAvailable = false; }
    reason ||= availability(effect, features, {...options, traits});
    return [{ id, label: effect.label, group: packFor(record.packId).label, collection: collectionLabel(packFor(record.packId).label),
      format: effect.format, sourcePath:file, traits, outputContract:Traits.outputContract(traits), category: traits.category,...(sourceRevision?{sourceRevision}:{}),
      ...(effect.recommended?{recommendationRank:0}:{}),nativeVideo: effect.nativeVideo, nativeVideoAvailable:nativeVideoAvailable&&traits.sharedOnly!==true&&!Object.keys(traits.sceneBindings||{}).length, installed: true, bundled: false, available: !reason, reason }];
  }
}
function resolveEffect(userDataDir, id, features = {}, graphicsHost, options = {}) {
  const selected = parseId(id);
  for (const record of selectedInstalls(userDataDir, selected.pack.id, options)) {
    const effect = effectEntries(record).find(row => row.id === selected.effect);
    if (!effect) continue;
    const traits = effectTraits(record, effect);
    const reason = availability(effect, features, { ...options, graphicsHost, traits });
    if (reason) throw new Error(reason);
    if (!module.exports.installed(userDataDir, selected.pack.id, record.version, true)) throw new Error("The installed shader pack changed. Reinstall this version.");
    const root = record.filesRoot || path.join(record.root, "files"), file = path.join(root, effect.file);
    const locations=collectionPaths(root,selected.pack,file);
    return { file, format: effect.format, traits, ...locations,
      runtimeIdentity: { managerId: ID, sectionId: record.packId, version: record.version, sourcePath: record.root } };
  }
  throw new Error("This shader collection version is not installed. Play offers its download.");
}
function missingEffectPlan(userDataDir, id, options = {}) {
  const selected = parseId(id), pack = selected.pack;
  if (selectedInstalls(userDataDir, pack.id, options).some(record => effectEntries(record).some(effect => effect.id === selected.effect) &&
      module.exports.installed(userDataDir, pack.id, record.version, true))) return null;
  const version = options.packVersion ?? options.settings?.runtimes?.[ID]?.defaultVersions?.[pack.id] ??
    available(userDataDir, pack.id).find(row => !row.reason)?.version ?? null;
  // An installed revision that lacks this content-addressed effect cannot be
  // repaired by downloading the same revision again.
  if (version && module.exports.installed(userDataDir, pack.id, version, true)) return null;
  return { managerId: ID, version, ...(!version ? { discoveryRequired: true } : {}), label: pack.label,
    requiresDownload: true, installOptions: { sectionId: pack.id } };
}
function collectionPaths(root,pack,file){
  const paths=names=>names.map(relative=>{
    if(!safe(relative))throw Error("The shader collection resource path is invalid.");
    const directory=path.join(root,relative),stat=fs.lstatSync(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||!fs.realpathSync(directory).startsWith(fs.realpathSync(root)+path.sep))throw Error("The shader collection resource directory is missing or outside its collection.");
    return directory;
  });
  return {includePaths:[...new Set([path.dirname(file),root,...paths(pack.includePaths||[])])],texturePaths:[...new Set([root,path.dirname(file),...paths(pack.texturePaths||[])])]};
}
// Release collections list each release's shader archive, in any format the
// shared extractor reads; the publisher's current name and the zip form come
// first. Source collections follow the newest commit of the default branch.
const sources = new Map(Catalog.packs.map(pack => [pack.id, pack.delivery === "release-zip"
  ? Upstream.github({ repository: pack.repository, recognize: release => {
    const assets = (release.assets || []).filter(item => new RegExp(pack.assetPattern, "i").test(item?.name || "") && Release.archiveFormat(item.name) &&
      !/(?:^|[-_.])(?:debug|symbols?)(?:[-_.]|$)/i.test(item.name));
    const rank = item => Release.ARCHIVE_FORMATS.indexOf(Release.archiveFormat(item.name));
    const asset = assets.sort((a, b) => rank(a) - rank(b))[0];
    return asset ? { version: String(release.tag_name).replace(/^v(?=\d)/, ""), details: { tag: release.tag_name }, assets: [asset] } : null;
  } })
  : Upstream.githubCommits({ repository: pack.repository, limit: 1 })]));
const tree = (pack, commit, signal) => Upstream.githubTree({ repository: pack.repository, revision: commit, signal });
const raw = (pack, ref, relative) => Upstream.listedFile({ filename: path.posix.basename(relative),
  url: `https://raw.githubusercontent.com/${pack.repository}/${ref}/${relative.split("/").map(encodeURIComponent).join("/")}` });
// The files one revision provides for installation, or the reason it cannot
// be installed: a declared recipe input or the license notice is missing, no
// supported shader remains (a recipe writes its own), or the selection
// exceeds the library limits.
function selectTree(pack, tree, recipe) {
  if (tree?.truncated || !Array.isArray(tree?.tree) || tree.tree.length > 20000) return { reason: "The shader source listing is too large." };
  const blobs = tree.tree.filter(item => item?.type === "blob" && safe(item.path)), inputs = new Set(recipe?.sourceFiles || []);
  const files = pack.delivery !== "tree" ? blobs.filter(item => keep(item.path)) : blobs.filter(item => inputs.has(item.path) || keep(item.path) &&
    (pack.prefixes.some(prefix => item.path.startsWith(prefix)) || item.path === pack.licenseFile || /^README/i.test(item.path)));
  const missing = [...inputs, pack.licenseFile].find(file => !blobs.some(item => item.path === file));
  if (missing) return { reason: `This revision does not contain ${missing}.` };
  if (!recipe && !files.some(item => formats[path.extname(item.path).toLowerCase()])) return { reason: "This revision contains no supported shader files." };
  if (pack.delivery === "tree" && (files.length > LIMITS.entries || files.some(item => item.size > LIMITS.file) ||
    files.reduce((sum, item) => sum + item.size, 0) > LIMITS.expanded)) return { reason: "This revision exceeds the shader library size limits." };
  return { files };
}
async function refreshCatalog(context = {}) {
  const packs = context.sectionId ? [packFor(context.sectionId)] : Catalog.packs;
  await Promise.all(packs.map(async pack => {
    const key = directory(context.userDataDir, pack.id), previous = cached(context.userDataDir, pack.id);
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      states.set(key, { status: "loading", error: null });
      try {
        let entries;
        const listed = await sources.get(pack.id).discover({ signal: context.signal, logger: context.logger });
        if (pack.delivery === "release-zip") {
          entries = listed.filter(row => row.files[0]).map(row => ({ version: row.version, tag: row.details?.tag || row.version, date: row.publishedAt,
            archive: { url: row.files[0].url, bytes: row.files[0].bytes, sha256: row.files[0].digest?.algorithm === "sha256" ? row.files[0].digest.value : null } }))
            .filter(row => validRow(pack, row));
        } else {
          const head = listed[0];
          if (!head) throw new Error("The shader collection lists no commit.");
          const row = { version: sourceVersion(pack,head.revision), commit: head.revision, date: head.publishedAt,
            ...(pack.sourceOverlay?{adaptationVersion:pack.sourceOverlay.version}:{}) };
          // Each listed commit is immutable. A new one that lacks declared files
          // stays listed with its reason; earlier commits remain installable.
          const known = previous?.entries.find(item => item.version === row.version);
          if (known) row.reason = known.reason;
          else if (validRow(pack, row)) try {
            row.reason = selectTree(pack, await tree(pack, row.commit, context.signal), sourceOverlayFor(pack, row)).reason;
          } catch (error) { Downloads.throwIfAborted(context.signal); }
          if (!row.reason) delete row.reason;
          entries = [row];
        }
        // A release list is the publisher's own; commit heads accumulate.
        const rows = new Map([...(pack.delivery === "release-zip" ? [] : available(context.userDataDir, pack.id)), ...entries].map(row => [row.version, row]));
        const record = { repository: pack.repository, fetchedAt: Date.now(), entries: [...rows.values()].filter(row => validRow(pack, row)).slice(-LIMITS.versions) };
        if (!record.entries.length) throw new Error("No compatible shader pack versions were found.");
        Downloads.throwIfAborted(context.signal);
        Writable.assertOwnDirectory(context.userDataDir, key);
        Writable.atomicWrite(path.join(key, "catalog.json"), JSON.stringify(record, null, 2) + "\n", { root: context.userDataDir });
        states.set(key, { status: "success", error: null });
      } catch (error) { states.set(key, { status: "error", error: error.message }); throw error; }
      finally { pending.delete(key); }
    })();
    pending.set(key, task); return task;
  }));
  return true;
}
function keep(relative) {
  return Boolean(formats[path.extname(relative).toLowerCase()]) || /\.(?:vs|fxh|h|hlsl|hlsli|inc|glslinc|png|jpg|jpeg|bmp|tga|dds|webp|cube|lut|txt|md|json|ini)$/i.test(relative) ||
    /^(?:LICENSE|NOTICE|COPYING|AUTHORS)(?:[._-].*)?$/i.test(path.posix.basename(relative));
}
function extract(archive, destination) {
  const info = Zip.readZipEntries(archive)?.info;
  if (!info || info.entries > LIMITS.entries) throw new Error("The shader archive is invalid or too large.");
  const fd = fs.openSync(archive, "r"); let entries;
  try { entries = Zip.readCentralDirectory(fd, info, { metadata: true }); } finally { fs.closeSync(fd); }
  if (entries.length !== info.entries) throw new Error("The shader archive is incomplete.");
  const names = new Set(); let expanded = 0;
  const files = entries.filter(entry => !entry.name.endsWith("/"));
  const first = files[0]?.name.split("/")[0], prefix = first && files.every(row => row.name.startsWith(first + "/")) ? first + "/" : "";
  for (const entry of entries) {
    const relative = entry.name.replace(/\/$/, ""), mode = entry.externalAttributes >>> 16;
    if (!safe(relative) || names.has(relative.toLowerCase()) || (mode & 0o170000) === 0o120000 || entry.flags & 1 ||
      entry.uncompressedSize > LIMITS.file || (expanded += entry.uncompressedSize) > LIMITS.expanded)
      throw new Error("The shader archive contains an unsafe or oversized entry.");
    names.add(relative.toLowerCase());
    if (entry.name.endsWith("/")) continue;
    const target = relative.slice(prefix.length);
    if (!keep(target)) continue;
    const bytes = Zip.readZipEntry(archive, entry, { maxOutputBytes: LIMITS.file });
    if (!bytes || bytes.length !== entry.uncompressedSize) throw new Error("A shader archive file could not be extracted.");
    const file = path.join(destination, target); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: "wx" });
  }
}
// A listed file, verified by the publisher's size and digest when given; a
// transfer larger than the library limit stops.
async function download(listed, file, context, maxBytes = LIMITS.archive) {
  const limit = new AbortController(), signal = context.signal ? AbortSignal.any([context.signal, limit.signal]) : limit.signal;
  try {
    await Upstream.download(listed, file, { signal, onProgress: progress => {
      if (progress.downloaded > maxBytes || progress.total > maxBytes) limit.abort();
      context.onProgress?.(progress);
    } });
    if (fs.statSync(file).size > maxBytes) throw new Error("The shader download is too large.");
  } catch (error) { if (limit.signal.aborted && !context.signal?.aborted) throw new Error("The shader download is too large."); throw error; }
}
// Zip archives are read entry by entry; other formats are unpacked by the
// shared extractor first. Both keep only shader, resource and notice files
// below a single top folder.
async function unpack(archive, destination, signal) {
  if (Release.archiveFormat(archive) === ".zip") return extract(archive, destination);
  const staging = fs.mkdtempSync(destination + "-unpacked-");
  try {
    await Release.extractArchive(archive, staging, signal);
    const top = fs.readdirSync(staging).filter(name => name !== "__MACOSX" && !name.startsWith("."));
    const root = top.length === 1 && fs.lstatSync(path.join(staging, top[0])).isDirectory() ? path.join(staging, top[0]) : staging;
    let count = 0, expanded = 0;
    (function visit(directory, prefix) {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix + item.name, source = path.join(directory, item.name);
        if (item.name === "__MACOSX" || item.name === ".DS_Store") continue;
        if (!safe(relative) || item.isSymbolicLink()) throw new Error("The shader archive contains an unsafe or oversized entry.");
        if (item.isDirectory()) { visit(source, relative + "/"); continue; }
        if (!item.isFile() || !keep(relative)) continue;
        const size = fs.statSync(source).size;
        if (++count > LIMITS.entries || size > LIMITS.file || (expanded += size) > LIMITS.expanded) throw new Error("The shader archive contains an unsafe or oversized entry.");
        const target = path.join(destination, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); cloneOrCopySync(source, target, { exclusive: true });
      }
    })(root, "");
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
function discover(files, pack, { ignoreMetadata = false, curated = true } = {}) {
  const inventory = {}, effects = [], seen = new Set(); let count = 0, total = 0;
  let entrypoints;
  if(curated&&pack.entrypoints!==undefined){
    if(!Array.isArray(pack.entrypoints)||!pack.entrypoints.length||pack.entrypoints.length>LIMITS.entries)throw Error("The shader collection entry points are invalid.");
    entrypoints=new Map();for(const row of pack.entrypoints){if(!row||!safe(row.file)||!formats[path.extname(row.file).toLowerCase()]||entrypoints.has(row.file)||typeof row.label!=="string"||!row.label||row.label.length>512||/[\x00-\x1f]/.test(row.label))throw Error("The shader collection entry points are invalid.");entrypoints.set(row.file,row.label);}
  }
  function visit(root, prefix = "") {
    for (const row of fs.readdirSync(root, { withFileTypes: true })) {
      if (ignoreMetadata && [".git", ".DS_Store"].includes(row.name)) continue;
      const relative = prefix + row.name, file = path.join(root, row.name);
      if (!safe(relative) || row.isSymbolicLink()) throw new Error("The shader pack contains an unsafe path.");
      if (row.isDirectory()) { visit(file, relative + "/"); continue; }
      const stat = fs.statSync(file);
      if (!row.isFile() || ++count > LIMITS.entries || stat.size > LIMITS.file || (total += stat.size) > LIMITS.expanded)
        throw new Error("The shader pack contains too many or oversized files.");
      const bytes = fs.readFileSync(file), sha256 = hash(bytes);
      inventory[relative] = { bytes: bytes.length, sha256 };
      const format = formats[path.extname(relative).toLowerCase()];
      if (!format || seen.has(sha256.slice(0, 16))) continue;
      const text = bytes.toString("utf8");
      if (format === "magpie" && !/^\s*\/\/!MAGPIE EFFECT\s*$/m.test(text)) continue;
      if (text.includes("\0")) throw new Error("The shader source contains invalid text.");
      const traits = Traits.analyzeFile(file, format).traits, nativeVideo = format === "libplacebo" && traits.sharedOnly!==true && (traits.requiresVideoPlanes || traits.requiresDerivedPlanes ||
        pack.videoPaths?.some(item => relative.startsWith(item)));
      effects.push({ id: sha256.slice(0, 16), file: relative, format, label: entrypoints?.get(relative)||relative.replace(/\.[^.]+$/, "").replace(/_/g, " "),...(entrypoints?.has(relative)?{recommended:true}:{}),traits, traitsVersion: Traits.VERSION, nativeVideo });
      seen.add(sha256.slice(0, 16));
    }
  }
  visit(files);
  if (!effects.length) throw new Error("The selected archive contains no supported shader files.");
  return { files: inventory, effects };
}
function inspectCustom(runtimePath, { sectionId } = {}) {
  const pack = packFor(sectionId);
  if (!fs.statSync(runtimePath).isDirectory()) throw new Error("Select a complete shader collection folder, including its shader, include and texture files.");
  const filesRoot = fs.existsSync(path.join(runtimePath, "pack.json")) && fs.existsSync(path.join(runtimePath, "files")) ? path.join(runtimePath, "files") : runtimePath;
  const identities = []; let total = 0;
  function visit(root, prefix = "", depth = 0) {
    if (depth > 24) throw new Error("The shader collection is too deeply nested.");
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if ([".git", ".DS_Store"].includes(entry.name)) continue;
      const file = path.join(root, entry.name), relative = prefix + entry.name, stat = fs.lstatSync(file);
      if (!safe(relative) || stat.isSymbolicLink() || identities.length >= LIMITS.entries) throw new Error("The shader collection contains an unsupported path or too many files.");
      if (stat.isDirectory()) { visit(file, relative + "/", depth + 1); continue; }
      if (!stat.isFile() || stat.size > LIMITS.file || (total += stat.size) > LIMITS.expanded) throw new Error("The shader collection exceeds its size limit.");
      identities.push([relative, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    }
  }
  visit(filesRoot);
  const identity = JSON.stringify(identities), key = JSON.stringify([filesRoot, sectionId]), cached = customCollections.get(key);
  const collection = cached?.identity === identity ? cached.collection : discover(filesRoot, pack, { ignoreMetadata: true, curated:false });
  if (cached?.identity !== identity) {
    if (customCollections.size >= 32) customCollections.delete(customCollections.keys().next().value);
    customCollections.set(key, { identity, collection });
  }
  const expectedFormat={mpv:["libplacebo"],isf:["isf"],magpie:["magpie"],reshade:["fx"],libretro:["slangp","slang"]}[pack.family];
  const effects = collection.effects.filter(effect => !expectedFormat || expectedFormat.includes(effect.format));
  if (!effects.length) throw new Error("This runtime list requires a compatible "+({isf:"ISF",magpie:"MagpieFX",reshade:"ReShade FX",libretro:"Slang"}[pack.family]||"mpv")+" shader collection.");
  return { ...collection, effects, root: runtimePath, installDir: runtimePath, filesRoot, packId: sectionId, ready: true };
}
async function installRuntime(context = {}) {
  const pack = packFor(context.sectionId);
  let rows = available(context.userDataDir, pack.id), selected = context.version ? version(context.version) : rows.find(row => !row.reason)?.version;
  const current = selected && installed(context.userDataDir, pack.id, selected, true); if (current) return current;
  await confirmToolInstall(context, { managerId: ID, label: pack.label, version: selected || null, requiresDownload: true,
    installOptions: { sectionId: pack.id }, detail: "Downloads the selected shader source collection and its license notices." });
  if (!rows.some(row => row.version === selected)) {
    await module.exports.refreshCatalog({ ...context, sectionId: pack.id });
    rows = available(context.userDataDir, pack.id);
    selected = context.version ? version(context.version) : rows.find(row => !row.reason)?.version;
  }
  const row = rows.find(item => item.version === selected);
  if (!row) throw new Error("The selected shader collection version is unavailable.");
  if (row.reason) throw new Error(row.reason);
  return withRuntimeMutation({ managerId: ID, sectionId: pack.id, version: selected }, async () => {
    const current = installed(context.userDataDir, pack.id, selected, true); if (current) return current;
    return runDownloadTask(context.downloads, { managerId: ID, sectionId: pack.id, version: selected, label: pack.label,
      kind: "runtime", dedupeKey: `${ID}:${context.userDataDir}:${pack.id}:${selected}` }, async task => {
      const signal = task.signal && context.signal ? AbortSignal.any([task.signal, context.signal]) : task.signal || context.signal,
        root = directory(context.userDataDir, pack.id);
      Writable.assertOwnDirectory(context.userDataDir, root);
      const temporary = fs.mkdtempSync(path.join(root, ".install-")), files = path.join(temporary, "files"); fs.mkdirSync(files);
      let backup, published = false;
      try {
        const downloadContext = { signal, onProgress: task.onProgress || context.onProgress },sourceRecipe=sourceOverlayFor(pack,row);
        if (pack.delivery === "tree") {
          const { files: selectedFiles, reason } = selectTree(pack, await tree(pack, row.commit, signal), sourceRecipe);
          if (reason) throw new Error(reason);
          let next = 0;
          const cancellation = new AbortController(), workerSignal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
          const completed = await Promise.allSettled(Array.from({ length: Math.min(4, selectedFiles.length) }, async () => {
            try { while (next < selectedFiles.length) {
              Downloads.throwIfAborted(workerSignal);
              const item = selectedFiles[next++], target = path.join(files, item.path); fs.mkdirSync(path.dirname(target), { recursive: true });
              await download(raw(pack, row.commit, item.path), target, { ...downloadContext, signal: workerSignal }, LIMITS.file);
              const bytes = fs.readFileSync(target);
              if (bytes.length !== item.size || crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== item.sha)
                throw new Error("A shader source file does not match its selected Git revision.");
            } } catch (error) { cancellation.abort(); throw error; }
          }));
          const failure = completed.find(row => row.status === "rejected");
          if (failure) throw failure.reason;
        } else {
          // A release archive carries the publisher's size and digest; a source
          // archive at an exact commit is recorded as downloaded.
          const listed = row.archive ? Upstream.listedFile({ filename: path.posix.basename(new URL(row.archive.url).pathname), url: row.archive.url,
            bytes: row.archive.bytes, ...(row.archive.sha256 ? { sha256: row.archive.sha256 } : {}) })
            : Upstream.listedFile({ filename: `${pack.repository.split("/")[1]}-${row.commit}.zip`, url: `https://codeload.github.com/${pack.repository}/zip/${row.commit}` });
          const archive = path.join(temporary, listed.name);
          await download(listed, archive, downloadContext);
          await unpack(archive, files, signal); fs.rmSync(archive);
          if (!fs.existsSync(path.join(files, pack.licenseFile)))
            await download(raw(pack, row.commit || row.tag, pack.licenseFile), path.join(files, pack.licenseFile), downloadContext, 1 << 20);
        }
        for(const relative of pack.bundledNotices||[]){
          if(!safe(relative))throw Error("The shader collection notice path is invalid.");
          const moduleRoot=require("./shader-packs").physicalModuleRoot(),source=path.join(moduleRoot,relative),stat=fs.lstatSync(source);
          if(!stat.isFile()||stat.isSymbolicLink())throw Error("The shader collection license notice is unavailable.");
          const target=path.join(files,"notices",path.basename(relative));fs.mkdirSync(path.dirname(target),{recursive:true});
          if(fs.existsSync(target)){if(!fs.readFileSync(target).equals(fs.readFileSync(source)))throw Error("The shader collection notice conflicts with its source.");}
          else cloneOrCopySync(source,target);
        }
        let sourceOverlay;
        if(sourceRecipe){
          sourceOverlay=sourceRecipe.apply(files,row);
          if(sourceOverlay?.version!==row.adaptationVersion)throw Error("The shader collection source recipe version changed.");
        }
        const record = { schema: 1, packId: pack.id, version: selected, source: row, license: pack.license,
          ...(sourceOverlay?{sourceOverlay}:{}),installedAt: new Date().toISOString(), ...discover(files, pack) };
        if (!record.files[pack.licenseFile]) throw new Error("The shader pack license notice is missing.");
        for (const relative of Object.keys(record.files)) fs.chmodSync(path.join(files, relative), 0o444);
        fs.writeFileSync(path.join(temporary, "pack.json"), JSON.stringify(record, null, 2) + "\n");
        Downloads.throwIfAborted(signal);
        const target = installRoot(context.userDataDir, pack.id, selected);
        if (fs.existsSync(target)) { backup = target + ".previous-" + crypto.randomUUID(); fs.renameSync(target, backup); }
        fs.renameSync(temporary, target);
        published = true;
        const result = installed(context.userDataDir, pack.id, selected, true);
        if (!result) throw new Error("The installed shader pack failed its integrity check.");
        if (backup) fs.rmSync(backup, { recursive: true, force: true });
        context.onRuntimeStateChange?.(); return result;
      } catch (error) {
        if (backup) { const target = installRoot(context.userDataDir, pack.id, selected); fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(backup, target); }
        else if (published) fs.rmSync(installRoot(context.userDataDir, pack.id, selected), { recursive: true, force: true });
        throw error;
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    }, { onProgress: context.onProgress });
  }, { userDataDir: context.userDataDir });
}
async function uninstallRuntime({ userDataDir, sectionId, version: selected, installDir } = {}) {
  const target = installRoot(userDataDir, sectionId, selected);
  if (installDir && path.resolve(installDir) !== target) throw new Error("The selected directory does not belong to this shader pack.");
  Writable.assertOwnDirectory(userDataDir, target, { create: false });
  return withRuntimeMutation({ managerId: ID, sectionId, version: selected, sourcePath: target }, () => {
    fs.rmSync(target, { recursive: true, force: true }); verified.delete(target); return true;
  }, { userDataDir });
}
module.exports = { ID, Catalog, LIMITS, sources, isId, listEffects, resolveEffect, missingEffectPlan, directory, installRoot, installed, normalizeVersion: version,
  listInstalled, cached, available, refreshCatalog, installRuntime, uninstallRuntime, states, inspectCustom,
  __test: { discover, extract, validRow, safe, selectTree } };
