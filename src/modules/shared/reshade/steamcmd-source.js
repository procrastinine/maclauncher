// Copyright (c) MacLauncher contributors. MIT license.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Upstream = require('../runtime/upstream'), Native = require('../runtime/local-native');
const {parseSteamVdf} = require('../../../core/steam-installed-games');
const ORIGIN = 'https://steamcdn-a.akamaihd.net/client/', location = ORIGIN + 'steam_cmd_osx';
// These are the native siblings in Valve's macOS SteamCMD package. A custom
// executable is checked with the same CPU and required-file contract.
const LIBRARIES = ['crashhandler.dylib', 'libaudio.dylib', 'libsteaminput.dylib', 'libtier0_s.dylib', 'libvstdlib_s.dylib', 'steamclient.dylib', 'steamconsole.dylib'];
// Valve's macOS bootstrap declares these options. Every selected executable is
// checked for the same option contract before it can run a download session.
const BOOTSTRAP_ARGUMENTS = ['-skipinitialbootstrap', '-nobootstrapperupdate'];
function bootstrapArguments(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw Error('Invalid SteamCMD bootstrap executable.');
  const bytes = fs.readFileSync(file);
  if (!BOOTSTRAP_ARGUMENTS.every(flag => bytes.includes(Buffer.from(flag + '\0')))) throw Error('This SteamCMD executable cannot use the managed package without its bootstrap updater. Choose another version in Runtimes.');
  return [...BOOTSTRAP_ARGUMENTS];
}
function parse(text) {
  if (Buffer.byteLength(text) > 1024 * 1024) throw Error('Valve returned too much SteamCMD version metadata.');
  const manifest = parseSteamVdf(text).osx;
  if (!/^[1-9]\d{0,19}$/.test(manifest?.version || '')) throw Error('Valve returned no SteamCMD version.');
  const parts = Object.values(manifest).filter(row => row && typeof row === 'object' && row.file).map(row => {
    const bytes = Number(row.size);
    if (!/^steamcmd_[a-z0-9_]+\.zip\.[a-f0-9]{40}$/.test(row.file) || !/^[a-f0-9]{64}$/.test(row.sha2 || '') || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 256 * 1024 * 1024)
      throw Error('Valve returned an invalid SteamCMD package.');
    return {filename: row.file.replace(/\.[a-f0-9]{40}$/, ''), url: ORIGIN + row.file, bytes, sha256: row.sha2,
      bootstrap: row.IsBootstrapperPackage === '1'};
  });
  if (!parts.length || parts.length > 32 || parts.filter(row => row.bootstrap).length !== 1 || new Set(parts.map(row => row.filename)).size !== parts.length)
    throw Error('Valve returned an incomplete SteamCMD package list.');
  const primary = parts.find(row => row.bootstrap);
  return {version: manifest.version, sourceUrl: location, files: [{name: primary.filename, url: primary.url, bytes: primary.bytes, digest: primary.sha256}], details: {parts}};
}
const upstream = Upstream.index({locations: [location], hosts: ['steamcdn-a.akamaihd.net'], allArchitectures: true,
  parse: ([document]) => parse(document.text)});
function executable(runtimePath) {
  const file = fs.statSync(runtimePath).isDirectory() ? path.join(runtimePath, 'steamcmd') : runtimePath;
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw Error('Choose a SteamCMD executable or its package folder.');
  return file;
}
function inspect(options) {
  const file = executable(options.runtimePath), root = path.dirname(file), native = Native.resolveLocalRuntime({...options, runtimePath: file});
  bootstrapArguments(file);
  for (const name of LIBRARIES) {
    const sibling = path.join(root, name), stat = fs.lstatSync(sibling);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('The SteamCMD package is missing ' + name + '.');
    const cpus = Native.readMachOArchitectures(sibling, {allowLibrary: true});
    if (!native.architectures.every(cpu => cpus.includes(cpu))) throw Error('SteamCMD and ' + name + ' have different CPU slices.');
  }
  return native;
}
async function merge(source, destination) {
  for (const row of await fs.promises.readdir(source, {withFileTypes: true})) {
    const from = path.join(source, row.name), to = path.join(destination, row.name), existing = await fs.promises.lstat(to).catch(error => { if (error.code === 'ENOENT') return null;throw error; });
    if (row.isDirectory() && existing?.isDirectory() && !existing.isSymbolicLink()) await merge(from, to);
    else { if (existing) throw Error('SteamCMD package parts contain conflicting files.');await fs.promises.rename(from, to); }
  }
}
async function prepare({unpacked, pin, signal}, dependencies = {}) {
  const download = dependencies.download || Upstream.download, extract = dependencies.extractArchive || require('../runtime/release-files').extractArchive;
  const validPart = part => /^steamcmd_[a-z0-9_]+\.zip$/.test(part?.filename || '') &&
    part.url?.startsWith(ORIGIN + part.filename + '.') && /^[a-f0-9]{40}$/.test(part.url.slice((ORIGIN + part.filename + '.').length)) &&
    /^[a-f0-9]{64}$/.test(part.sha256 || '') && Number.isSafeInteger(part.bytes) && part.bytes > 0 && part.bytes <= 256 * 1024 * 1024;
  if (!Array.isArray(pin.parts) || !pin.parts.length || pin.parts.length > 32 || !pin.parts.every(validPart) ||
    pin.parts.filter(part => part.bootstrap).length !== 1 || !pin.parts.some(part => part.bootstrap && part.url === pin.asset?.url && part.sha256 === pin.asset?.sha256))
    throw Error('SteamCMD package parts differ from the selected Valve manifest.');
  for (const part of pin.parts || []) {
    if (part.bootstrap) continue;
    const scratch = path.join(path.dirname(unpacked), '.steamcmd-part-' + crypto.randomUUID()), archive = scratch + '.zip';
    try {
      await download(Upstream.listedFile(part), archive, {signal});
      const stat = await fs.promises.lstat(archive), hash = Native.hashFile(archive);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== part.bytes || hash !== part.sha256) throw Error('SteamCMD package part differs from Valve metadata.');
      await extract(archive, scratch, signal);await merge(scratch, unpacked);
    } finally { await fs.promises.rm(archive, {force: true});await fs.promises.rm(scratch, {recursive: true, force: true}); }
  }
  const file = executable(unpacked);
  await (dependencies.verifySigner || ((file, options) => require('../runtime/developer-id').verifyDeveloperId(file, 'MXGJJ98X76', options)))(file, {signal});
  return {publisherVersion: pin.version};
}
module.exports = {location, upstream, LIBRARIES, BOOTSTRAP_ARGUMENTS, bootstrapArguments, parse, executable, inspect, prepare};
