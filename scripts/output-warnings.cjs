const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process'), { createInflateRaw } = require('node:zlib');
const Content = require('./runtime-content.cjs'), Native = require('./native-binary-tools.cjs');
const MachO = require('../src/modules/shared/runtime/macho-load-commands'), B = require('../src/modules/shared/runtime/bundled-native');
const root = fs.realpathSync(process.argv[2]), cpu = process.argv[3] === 'x64' ? 'x86_64' : process.argv[3];
const files = [], members = [], hashes = new Map(), digests = new Map(), images = new Map();
const pkg = require('../package.json'), asar = require('@electron/asar');
const warning = text => console.log('::warning::' + text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A'));
const relative = file => path.relative(root, file);
const contained = file => fs.existsSync(file) && fs.realpathSync(file).startsWith(root + path.sep);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function json(bytes, name) {
  try { return JSON.parse(bytes); } catch { warning(`Invalid generated JSON: ${name}`); return null; }
}
async function digest(file) {
  const real = fs.realpathSync(file);
  if (!digests.has(real)) {
    const hash = crypto.createHash('sha256');
    for await (const bytes of fs.createReadStream(real)) hash.update(bytes);
    digests.set(real, hash.digest('hex'));
  }
  return digests.get(real);
}
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else { members.push(file); if (entry.isFile()) files.push(file); }
  }
}
function record(name, hash) {
  if (hashes.has(hash)) warning(`Identical files: ${hashes.get(hash)} and ${name}`);
  else hashes.set(hash, name);
  const reason = Content.excludedReason(name);
  if (reason) warning(`${reason}: ${name}`);
}
function signature(file, deep = false) {
  const result = spawnSync('/usr/bin/codesign', ['--verify', '--strict', ...(deep ? ['--deep'] : []), file], { encoding: 'utf8' });
  if (result.status !== 0) warning(`Invalid or missing code signature: ${relative(file) || path.basename(root)}: ${(result.stderr || result.error?.message || '').trim()}`);
}
async function inventory(file, value, declarations) {
  const base = value.directoryRelative ? path.resolve(path.dirname(path.dirname(file)), value.directoryRelative) :
    fs.statSync(path.join(path.dirname(file), 'files'), { throwIfNoEntry: false })?.isDirectory() ? path.join(path.dirname(file), 'files') : path.dirname(file);
  if (!base.startsWith(root + path.sep)) { warning(`Package manifest points outside output: ${relative(file)}`); return; }
  let rows;
  try {
    rows = require('../src/modules/shared/runtime/package-contract.cjs').logicalFiles(value, (target, dependency) =>
      declarations.find(item => path.basename(item.file) === dependency.sha256 + '.json')?.value.files.find(row => row.path === target.path));
  } catch (error) { warning(`Invalid generated package inventory: ${relative(file)}: ${error.message}`); return; }
  const expected = new Set();
  for (const row of rows) {
    const target = path.resolve(base, row.path); expected.add(target);
    if (!target.startsWith(base + path.sep) || !contained(target) || !fs.statSync(target).isFile()) { warning(`Package file missing or unsafe: ${relative(file)}: ${row.path}`); continue; }
    const stat = fs.statSync(target);
    if (stat.size !== row.size || await digest(target) !== row.sha256 || (stat.mode & 0o777) !== row.mode)
      warning(`Package file differs from generated manifest: ${relative(file)}: ${row.path}`);
  }
  for (const key of Object.keys(value).filter(key => key.endsWith('Relative') && typeof value[key] === 'string')) {
    const expectedHash = value[key.slice(0, -8) + 'Sha256'];
    if (!expectedHash) continue;
    const target = path.resolve(base, value[key]); expected.add(target);
    if (!contained(target) || await digest(target) !== expectedHash) warning(`Package metadata digest differs: ${relative(file)}: ${key}`);
  }
  for (const target of members) if (target.startsWith(base + path.sep) && target !== file && !expected.has(target))
    warning(`Package file absent from generated manifest: ${relative(file)}: ${path.relative(base, target)}`);
}
async function zip(archive) {
  if (!fs.existsSync(archive)) { warning('Release ZIP is missing: ' + archive); return; }
  const Zip = require('../src/modules/shared/runtime/zip'), fd = fs.openSync(archive, 'r');
  const info = Zip.findZipEocd(fd), entries = info && Zip.readCentralDirectory(fd, info, { metadata: true });
  fs.closeSync(fd);
  if (!entries || entries.length !== info.entries) { warning('Release ZIP directory is incomplete: ' + archive); return; }
  const remaining = new Set(members), names = new Set();
  for (const entry of entries) {
    if (names.has(entry.name)) warning('Duplicate release ZIP path: ' + entry.name);
    names.add(entry.name);
    if (entry.name.endsWith('/') || entry.name.startsWith('__MACOSX/')) continue;
    const target = path.resolve(path.dirname(root), entry.name);
    if (!target.startsWith(root + path.sep) || !remaining.delete(target)) { warning('Release ZIP file differs from app: ' + entry.name); continue; }
    const stat = fs.lstatSync(target), expected = stat.isSymbolicLink() ? sha(Buffer.from(fs.readlinkSync(target))) : await digest(target);
    const input = fs.openSync(archive, 'r'), header = Buffer.alloc(30);
    fs.readSync(input, header, 0, header.length, entry.absoluteLocalHeaderOffset); fs.closeSync(input);
    const start = entry.absoluteLocalHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), hash = crypto.createHash('sha256');
    const stream = entry.compressedSize ? fs.createReadStream(archive, { start, end: start + entry.compressedSize - 1 }) : require('node:stream').Readable.from([]);
    const output = entry.compressionMethod === 8 ? stream.pipe(createInflateRaw()) : stream;
    if (output !== stream) stream.on('error', error => output.destroy(error));
    try {
      let size = 0; for await (const bytes of output) { hash.update(bytes); size += bytes.length; }
      if (hash.digest('hex') !== expected || size !== entry.uncompressedSize || (entry.externalAttributes >>> 16 & 0o777) !== (stat.mode & 0o777))
        warning('Release ZIP bytes or permissions differ from app: ' + entry.name);
    } catch (error) { warning(`Unreadable release ZIP member: ${entry.name}: ${error.message}`); }
    finally { stream.destroy(); if (output !== stream) output.destroy(); }
  }
  for (const file of remaining) warning('Release ZIP missing app file: ' + relative(file));
}
async function main() {
  walk(root);
  const declarations = [], documents = new Map();
  for (const file of files) {
    const name = relative(file); record(name, await digest(file));
    if (Native.macho(file)) {
      try { images.set(file, MachO.readMachOLoadCommands(file)); } catch (error) { warning(`Invalid Mach-O: ${name}: ${error.message}`); }
    }
    if (file.endsWith('.json')) {
      const value = json(fs.readFileSync(file), name);
      documents.set(file, value);
      if ((value?.directoryRelative || value?.managerId) && Array.isArray(value.files)) declarations.push({ file, value });
    }
    if (file.endsWith('.asar')) {
      try {
      for (const member of asar.listPackage(file).map(name => name.replace(/^\//, ''))) {
        const item = asar.statFile(file, member, false);
        if (item.files || item.link) continue;
        let bytes;
        try { bytes = asar.extractFile(file, member); } catch { warning('ASAR file is missing or unreadable: ' + member); continue; }
        const hash = sha(bytes);
        if (!item.unpacked) record(name + '/' + member, hash);
        if (item.integrity && (item.integrity.algorithm !== 'SHA256' || hash !== item.integrity.hash)) warning('ASAR file differs from generated integrity: ' + member);
      }
      } catch (error) { warning(`Invalid ASAR output: ${name}: ${error.message}`); }
    }
  }
  for (const item of declarations) await inventory(item.file, item.value, declarations);
  const plist = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(root, 'Contents/Info.plist')], { encoding: 'utf8' });
  const info = plist.status === 0 ? json(plist.stdout, 'Info.plist') : null;
  if (!info) warning('Application Info.plist is missing or invalid');
  const archive = files.find(file => path.basename(file) === 'app.asar');
  let packed;
  if (archive) { try { packed = json(asar.extractFile(archive, 'package.json'), 'app.asar/package.json'); } catch { warning('Application ASAR package metadata is missing or unreadable'); } }
  if (info?.CFBundleShortVersionString !== pkg.version || packed?.version !== pkg.version || info?.CFBundleShortVersionString !== packed?.version)
    warning(`App version mismatch: source=${pkg.version}, Info.plist=${info?.CFBundleShortVersionString}, app.asar=${packed?.version}`);
  if (info && (info.CFBundleDisplayName !== pkg.build.productName || info.CFBundleIdentifier !== pkg.build.appId || info.LSMinimumSystemVersion !== pkg.build.mac.minimumSystemVersion || packed?.productName !== pkg.productName))
    warning('Application identity or declared minimum macOS differs between metadata');
  const executable = info?.CFBundleExecutable && path.join(root, 'Contents/MacOS', info.CFBundleExecutable);
  if (!executable || !contained(executable) || !(fs.statSync(executable).mode & 0o111)) warning('Application executable is missing or not executable');
  const python = files.find(file => documents.get(file)?.publisher === 'astral-sh/python-build-standalone');
  if (python) {
    const directory = path.dirname(python), selected = require('./python-resources.cjs').configuration(), interpreter = path.join(directory, selected.interpreter);
    if (!contained(interpreter) || !fs.statSync(interpreter).isFile() || !(fs.statSync(interpreter).mode & 0o111)) warning('Embedded Python interpreter is missing or not executable');
    for (const [name, target] of Object.entries(selected.aliases)) {
      const alias = path.join(directory, name);
      if (!fs.lstatSync(alias, { throwIfNoEntry: false })?.isSymbolicLink() || fs.readlinkSync(alias) !== target || !contained(alias) || fs.realpathSync(alias) !== interpreter)
        warning('Embedded Python alias does not point at the interpreter: ' + relative(alias));
    }
  }
  const executables = [...images].filter(([, info]) => info.slices.some(slice => slice.fileType === 2)).map(([file]) => path.dirname(file));
  for (const [file, image] of images) {
    if (!image.architectures.includes(cpu)) warning(`Mach-O has no ${cpu} slice: ${relative(file)}`);
    if (image.slices.some(slice => !slice.minimumMacOS || !B.versionAtLeast(pkg.build.mac.minimumSystemVersion, slice.minimumMacOS)))
      warning(`Mach-O minimum macOS exceeds package ${pkg.build.mac.minimumSystemVersion} or is absent: ${relative(file)}: ${image.slices.map(slice => slice.minimumMacOS).join(', ')}`);
    signature(file);
    const fd = fs.openSync(file, 'r'), result = spawnSync('/usr/bin/otool', ['-L', '/dev/fd/3'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd] }); fs.closeSync(fd);
    if (result.status !== 0) { warning('Unreadable Mach-O library links: ' + relative(file)); continue; }
    for (const link of Native.parseLinkedLibraries(result.stdout)) {
      if (link.startsWith('/usr/lib/') || link.startsWith('/System/')) continue;
      const resolved = link.startsWith('@rpath/') ? members.some(candidate => candidate.endsWith('/' + link.slice(7)) && contained(candidate)) :
        link.startsWith('@executable_path/') ? executables.some(directory => contained(path.resolve(directory, link.slice(17)))) : contained(link.replace(/^@loader_path/, path.dirname(file)));
      if (!resolved) warning(`Library outside output: ${relative(file)} links ${link}`);
    }
  }
  signature(root, true);
  for (const file of members) if (fs.lstatSync(file).isSymbolicLink() && !fs.existsSync(file)) warning('Dangling output alias: ' + relative(file));
  if (process.argv[4]) await zip(process.argv[4]);
  process.exitCode = 0;
}
main();
