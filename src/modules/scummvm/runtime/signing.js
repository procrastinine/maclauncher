const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { readAppBundleVersion } = require('../../shared/runtime/app-bundle');
const Native = require('../../shared/runtime/local-native');
const MachO = require('../../shared/runtime/macho-load-commands');
const { versionAtLeast } = require('../../shared/runtime/bundled-native');
const { throwIfAborted } = require('../../shared/runtime/download-utils');
const { prepareClones } = require('../../shared/runtime/clone-file');
const execute = promisify(execFile);
const POLICY = 'ad-hoc-no-hardened-runtime-v1';
const order = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const nativeMagic = new Set([0xcafebabe,0xbebafeca,0xcafebabf,0xbfbafeca,0xfeedface,0xcefaedfe,0xfeedfacf,0xcffaedfe]);

function appRoot(executable) {
  const marker = path.sep + 'ScummVM.app' + path.sep;
  const index = executable.lastIndexOf(marker);
  return index < 0 ? null : executable.slice(0, index + marker.length - 1);
}
function inventory(app, { hashFiles = true, inspectNative = false } = {}) {
  app = fs.realpathSync(app);
  const files = [], natives = [], bundles = [], identities = [];
  function walk(relative) {
    for (const item of fs.readdirSync(path.join(app, relative), { withFileTypes: true }).sort((a,b)=>order(a.name,b.name))) {
      const name = relative ? relative + '/' + item.name : item.name, file = path.join(app, name);
      if (item.isDirectory()) {
        walk(name);
        if (/\.(?:app|framework|xpc|appex|bundle|docktileplugin)$/i.test(item.name)) bundles.push(name);
      } else if (item.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (!fs.realpathSync(file).startsWith(app + path.sep)) throw new Error('A ScummVM alias escapes its application.');
        const stat = fs.lstatSync(file,{bigint:true});
        files.push({ path: name, link: target });
        identities.push([name,target,stat.dev,stat.ino,stat.size,stat.mode,stat.mtimeNs,stat.ctimeNs].map(String));
      } else {
        const stat = fs.statSync(file, { bigint: true });
        if (!stat.isFile() || stat.size > 1024n ** 3n) throw new Error('ScummVM contains an unsupported file.');
        identities.push([name,stat.dev,stat.ino,stat.size,stat.mode,stat.mtimeNs,stat.ctimeNs].map(String));
        files.push({ path: name, size: Number(stat.size), mode: Number(stat.mode & 0o777n), ...(hashFiles ? { sha256: Native.hashFile(file) } : {}) });
        if (inspectNative) {
          const fd = fs.openSync(file,'r'), bytes = Buffer.alloc(4); let count;
          try { count = fs.readSync(fd,bytes,0,4,0); } finally { fs.closeSync(fd); }
          if (count === 4 && nativeMagic.has(bytes.readUInt32BE(0))) natives.push({path:name,...MachO.readMachOLoadCommands(file)});
        }
      }
      if (files.length > 10000) throw new Error('The ScummVM application exceeds its file limit.');
    }
  }
  walk('');
  return { files, natives, bundles, identity: digest(JSON.stringify(identities)), ...(hashFiles ? { sha256: digest(JSON.stringify(files)) } : {}) };
}
function signatureFlags(stderr) {
  const match = /flags=0x([a-f0-9]+)/i.exec(stderr || '');
  if (!match || Number.parseInt(match[1],16) & 0x10000 || !(Number.parseInt(match[1],16) & 2))
    throw new Error('The installed ScummVM signature must be ad hoc without hardened runtime.');
  return '0x' + match[1];
}

async function prepareInstall({ unpacked, pin, signal }, { run = execute } = {}) {
  throwIfAborted(signal);
  const app = path.join(unpacked,'ScummVM.app');
  if (readAppBundleVersion(app) !== pin.version) throw new Error('ScummVM app version does not match the selected release.');
  const before = inventory(app,{inspectNative:true}), arch = process.arch === 'x64' ? 'x86_64' : process.arch;
  let minimumMacOS = '0.0';
  for (const image of before.natives) {
    if (!image.architectures.includes(arch) || image.slices.some(slice => slice.platform !== 1 || !slice.minimumMacOS))
      throw new Error('A ScummVM component does not support this Mac architecture or platform.');
    for (const slice of image.slices) if (versionAtLeast(slice.minimumMacOS,minimumMacOS)) minimumMacOS = slice.minimumMacOS;
  }
  if (!before.natives.some(image => image.path === 'Contents/MacOS/scummvm')) throw new Error('The selected ScummVM executable is missing.');
  const command = async args => { throwIfAborted(signal); return run('/usr/bin/codesign',args,{signal,timeout:30000,maxBuffer:1024*1024,encoding:'utf8'}); };
  // Sign actual native files and contained bundles from the inside out. Keep
  // the publisher's versioned framework layout, aliases and resource files.
  const sign = file => command(['--force','--sign','-','--options=0','--timestamp=none',file]);
  const targets = [...new Set([...before.natives.map(image=>image.path),...before.bundles])]
    .sort((a,b)=>b.split('/').length-a.split('/').length || order(a,b));
  for (const target of targets) await sign(path.join(app,target));
  await sign(app);
  await command(['--verify','--deep','--strict',app]);
  const nativeFiles = [];
  for (const image of before.natives) {
    const file = path.join(app,image.path);
    await command(['--verify','--strict',file]);
    const result = await command(['-d','--verbose=4',file]);
    nativeFiles.push({path:image.path,sha256:Native.hashFile(file),flags:signatureFlags(result.stderr)});
  }
  const after = inventory(app);
  const nativePaths = new Set(before.natives.map(image=>image.path)), finalFiles = new Map(after.files.map(file=>[file.path,file]));
  for (const file of before.files) {
    const final = finalFiles.get(file.path);
    if (!final) throw new Error('ScummVM signing removed a publisher file.');
    if (file.link !== undefined ? final.link !== file.link
      : !nativePaths.has(file.path) && !file.path.includes('/_CodeSignature/') &&
        (final.sha256 !== file.sha256 || final.size !== file.size || final.mode !== file.mode))
      throw new Error('ScummVM signing changed a publisher resource or alias.');
  }
  const originalPaths = new Set(before.files.map(file=>file.path));
  if (after.files.some(file=>!originalPaths.has(file.path) && !file.path.includes('/_CodeSignature/')))
    throw new Error('ScummVM signing added a non-signature file.');
  throwIfAborted(signal);
  return { appVersion:pin.version, architectures:before.natives.find(image=>image.path==='Contents/MacOS/scummvm').architectures,
    minimumMacOS, publisherTreeSha256:before.sha256, signedTreeSha256:after.sha256,
    signing:{policy:POLICY,identity:'-',hardenedRuntime:false,nativeFiles} };
}

async function repairLegacyInstallation(install, { signal, pin: selectedPin, prepare = module.exports.prepareInstall, resolveInstalled } = {}) {
  throwIfAborted(signal);
  const app = appRoot(install.executablePath), directory = install.installDir;
  if (!app || !directory || fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(app).isSymbolicLink() ||
      path.resolve(app) !== path.join(path.resolve(directory),'ScummVM.app'))
    throw new Error('ScummVM graphics preparation requires its managed publisher installation.');
  const recordPath = path.join(directory,'runtime.json'), recordBytes = fs.readFileSync(recordPath), record = JSON.parse(recordBytes);
  const pin = record.catalogEntry, filename = 'scummvm-' + record.version + '-macosx.dmg';
  const publisherUrl = require('./catalog').SOURCE_URL + record.version + '/' + filename;
  if (record.source !== 'download' || record.provenanceVerified !== true || record.integritySource !== 'publisher-sha256' ||
      record.version !== install.version || pin?.version !== record.version || selectedPin?.version !== record.version ||
      selectedPin.upstreamRevision !== record.upstreamRevision || selectedPin.asset?.sha256 !== record.archiveSha256 ||
      record.upstreamRevision !== pin.upstreamRevision || pin.asset?.filename !== filename || pin.asset?.url !== publisherUrl ||
      record.assetUrl !== publisherUrl || !/^[a-f0-9]{64}$/.test(record.archiveSha256 || '') || record.archiveSha256 !== pin.asset.sha256 ||
      !/^[a-f0-9]{64}$/.test(record.binarySha256 || '') || Native.hashFile(install.executablePath) !== record.binarySha256)
    throw new Error('The legacy ScummVM publisher archive or executable identity changed.');
  // The unchanged primary hash binds the publisher's original signed resource
  // envelope and nested signatures. Reject damage before signing any copy.
  const original = inventory(app,{hashFiles:false}), recordHash = digest(recordBytes);
  await execute('/usr/bin/codesign',['--verify','--deep','--strict',app],{signal,timeout:30000,maxBuffer:1024*1024});
  throwIfAborted(signal);
  const stage = fs.mkdtempSync(path.join(directory,'.scummvm-signing-'));
  const candidate = path.join(stage,'ScummVM.app'), previous = path.join(stage,'previous.app');
  const newRecordPath = path.join(stage,'runtime-new.json'), oldRecordPath = path.join(stage,'runtime-previous.json');
  let movedOriginal = false, publishedApp = false, publishedRecord = false, preserve = false;
  try {
    const clones = [];
    function copyLayout(input, output) {
      const stat = fs.lstatSync(input);
      if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(input),output);
      else if (stat.isDirectory()) {
        fs.mkdirSync(output,{mode:stat.mode & 0o777});
        for (const name of fs.readdirSync(input)) copyLayout(path.join(input,name),path.join(output,name));
      } else if (stat.isFile()) clones.push([input,output]);
      else throw new Error('ScummVM contains an unsupported file.');
    }
    copyLayout(app,candidate);
    await prepareClones(clones,signal);
    const metadata = await prepare({unpacked:stage,pin,signal});
    throwIfAborted(signal);
    if (digest(fs.readFileSync(recordPath)) !== recordHash || inventory(app,{hashFiles:false}).identity !== original.identity)
      throw new Error('The selected ScummVM installation changed during graphics preparation.');
    const catalogEntry = metadata.minimumMacOS && (!pin.minimumMacOS || versionAtLeast(metadata.minimumMacOS,pin.minimumMacOS))
      ? {...pin,minimumMacOS:metadata.minimumMacOS} : pin;
    const next = {...record,catalogEntry,binarySha256:Native.hashFile(path.join(candidate,'Contents/MacOS/scummvm')),
      installationMetadata:{...record.installationMetadata,...metadata}};
    const mode = fs.statSync(recordPath).mode & 0o777;
    fs.writeFileSync(newRecordPath,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode});
    fs.writeFileSync(oldRecordPath,recordBytes,{flag:'wx',mode});
    throwIfAborted(signal);
    fs.renameSync(app,previous); movedOriginal = true;
    fs.renameSync(candidate,app); publishedApp = true;
    fs.renameSync(newRecordPath,recordPath); publishedRecord = true;
    const installed = await resolveInstalled();
    if (!installed || installed.version !== record.version || installed.installationMetadata?.signing?.policy !== POLICY)
      throw new Error('ScummVM graphics preparation failed its installed record check.');
    throwIfAborted(signal);
    return installed;
  } catch (error) {
    try {
      if (publishedApp) fs.renameSync(app,path.join(stage,'failed.app'));
      if (movedOriginal) fs.renameSync(previous,app);
      if (publishedRecord) fs.renameSync(oldRecordPath,recordPath);
    } catch {
      preserve = true;
      throw new Error('ScummVM graphics preparation could not restore its original installation; retained files: ' + stage,{cause:error});
    }
    throw error;
  } finally { if (!preserve) fs.rmSync(stage,{recursive:true,force:true}); }
}

function createVerifier() {
  const cache = new Map();
  return function verify(install, { verification = 'full' } = {}) {
    const metadata = install?.installationMetadata;
    // Existing explicit local/publisher registrations retain their identity.
    // Their signature is not silently changed by selection or offline reuse.
    if (!metadata?.signing) return install;
    if (metadata.signing.policy !== POLICY || metadata.signing.identity !== '-' || metadata.signing.hardenedRuntime !== false ||
        !/^[a-f0-9]{64}$/.test(metadata.signedTreeSha256 || '') || !Array.isArray(metadata.signing.nativeFiles))
      throw new Error('ScummVM installation signing metadata changed.');
    const app = appRoot(install.executablePath);
    if (!app) throw new Error('ScummVM installation has no application bundle.');
    const current = inventory(app,{hashFiles:false}), previous = cache.get(app), metadataSha256 = digest(JSON.stringify(metadata));
    if (previous?.identity === current.identity && previous?.metadataSha256 === metadataSha256) return install;
    const full = inventory(app);
    if (full.sha256 !== metadata.signedTreeSha256 || metadata.signing.nativeFiles.some(file =>
      !full.files.some(member => member.path === file.path && member.sha256 === file.sha256))) throw new Error('The installed ScummVM files changed.');
    execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'pipe',timeout:30000});
    cache.set(app,{identity:current.identity,metadataSha256});
    return install;
  };
}
module.exports = { POLICY, appRoot, inventory, prepareInstall, repairLegacyInstallation, createVerifier };
