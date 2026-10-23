#!/usr/bin/env node
// Developer build and publication of the fixed AIM adaptation. Play uses only
// this sealed payload and a separately acquired original Android image.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {prepareAimSources,source} from '../src/modules/android/providers/aim/source.mjs';
import {archiveAndroidSourceTree} from './android-stage-sources.mjs';
const require = createRequire(import.meta.url);
const B = require('../src/modules/shared/runtime/bundled-native');
const Native = require('../src/modules/shared/runtime/local-native');
const Supplemental = require('./native-supplementals.cjs');
const Content = require('./runtime-content.cjs');
const ProductionSource = require('../src/modules/shared/runtime/production-source');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const owned = path.join(repo, 'src/modules/android/providers/aim');
const minimumMacOS = '26.0';
const binaries = ['aimctl','maclauncher-aim','aim-apps','aim-display','aim-binderd','aim-lock-holder','aim-pty-holder','guest-init','linux-run','linux-translate','android-image-extract','android-runtime-prepare'];
const imageProducts = ['daemon','art','boot-image','device-services','system-server','oat','moltenvk',
  ...['allocator','audio','bluetooth','camera','composer','gles','gnss','health','mapper','sensors','vulkan'].map(name=>'hal/'+name)];
const appHostFiles = ['target/aim/daemons/bin/aim-app-host-agent','target/aim/device-services/aim-nearby.jar',
  ...['aim-app-host-agent.rc','aim-system','aim-system.rc','services'].map(file=>'image/app-host/'+file)];
const run = (program,args,options={}) => execFileSync(program,args,{stdio:'inherit',...options});
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function copy(from,to) { fs.mkdirSync(path.dirname(to),{recursive:true}); fs.copyFileSync(from,to); }
function files(root,relative='') {
  return fs.readdirSync(path.join(root,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
    const name=path.posix.join(relative,entry.name);
    if(entry.isSymbolicLink()) throw new Error('Payload cannot contain symbolic links: '+name);
    return entry.isDirectory()?files(root,name):[name];
  });
}
function architecture(file) { try { return Native.readMachOArchitectures(file,{allowLibrary:true}); } catch { return null; } }
function inventory(root) { return files(root).map(file=>{
  const full=path.join(root,file),stat=fs.statSync(full),arch=architecture(full);
  return {path:file,size:stat.size,mode:stat.mode&0o777,sha256:sha(full),...(arch?{architectures:arch}:{})};
}); }
function overlaySources(root,manifest,seen=new Set()) {
  if(seen.has(manifest)) return seen;
  seen.add(manifest);
  for(const match of fs.readFileSync(path.join(root,manifest),'utf8').matchAll(/^source = "([^"]+)"/gm)) {
    B.relativeFile(match[1]); seen.add(match[1]);
    if(match[1].endsWith('.toml')) {
      // Includes are flat in the upstream schema.
      for(const nested of fs.readFileSync(path.join(root,match[1]),'utf8').matchAll(/^source = "([^"]+)"/gm)) { B.relativeFile(nested[1]);seen.add(nested[1]); }
    }
  }
  return seen;
}
function noticeTree(from,to) {
  for(const file of files(from)) copy(path.join(from,file),path.join(to,file));
}
function correspondingSource(build,stage) {
  const temporary=path.join(stage,'.corresponding-source');
  fs.mkdirSync(temporary,{recursive:true});
  try {
    // Only source inputs and instructions: never SDK archives, images, build
    // products, private data, downloaded tools or developer diagnostics.
    const aim=path.join(temporary,'aim');fs.mkdirSync(aim);
    const sourceOptions = root => ({recursive:true, verbatimSymlinks:true, filter:file => {
      const relative=path.relative(root,file),parts=relative.split(path.sep);
      return (!Content.excludedReason(relative) || relative==='crates/aim-build/src/test.rs') &&
        !parts.some(part=>
        ['__pycache__','.pytest_cache','.mypy_cache','.ruff_cache'].includes(part)) &&
        !/^(?:AGENTS\.md|\.fetched)$/i.test(path.basename(file)) && !file.endsWith('.pyc');
    }});
    for(const item of ['Cargo.toml','Cargo.lock','.cargo','crates','hal','daemons','java','tools','patches','upstream','image','licensing','docs','LICENSE','LICENSING.md','THIRD_PARTY_NOTICES.md']) {
      fs.cpSync(path.join(build,item),path.join(aim,item),sourceOptions(build));
    }
    // Export the declared original inputs, independently of the build cache's
    // other contents. Keep relative upstream header links relative.
    const aosp=path.join(build,'_build/aosp'),selected=new Set();
    for(const lock of ['hal/sources.lock','daemons/sources.lock','crates/aim-services/sources.lock',
      'patches/art-android/sources.lock','upstream/java-toolchain.lock']) {
      const text=fs.readFileSync(path.join(build,lock),'utf8');
      const scalars=Object.fromEntries([...text.matchAll(/^([A-Za-z_][A-Za-z_0-9]*)=([^\s"(]+)$/gm)].map(match=>[match[1],match[2]]));
      for(const match of text.matchAll(/"([^"\n]*\|[^"\n]*)"/g)) {
        const fields=match[1].replace(/\$\{?([A-Za-z_][A-Za-z_0-9]*)\}?/g,(_all,name)=>{
          if(!Object.hasOwn(scalars,name))throw new Error('AIM source lock has an unknown variable: '+name);
          return scalars[name];
        }).split('|');
        if(fields[0].startsWith('platform/')) selected.add(path.posix.join(fields[0].slice(9),fields[1]));
        else if(fields[2]?.startsWith('platform/')) selected.add(path.posix.join('aidl_api',fields[0],fields[1]));
      }
    }
    const roots=[...selected].sort((a,b)=>a.length-b.length||a.localeCompare(b));
    for(const relative of roots.filter((name,index)=>!roots.slice(0,index).some(parent=>name.startsWith(parent+'/')))) {
      B.relativeFile(relative);
      fs.cpSync(path.join(aosp,relative),path.join(aim,'upstream-source/aosp',relative),sourceOptions(aosp));
    }
    fs.cpSync(owned,path.join(temporary,'maclauncher/src/modules/android/providers/aim'),{...sourceOptions(owned),filter:file=>
      sourceOptions(owned).filter(file) && path.relative(owned,file).split(path.sep)[0]!=='resources'});
    const native=path.join(repo,'src/modules/android/native');
    for(const file of fs.readdirSync(native).filter(file=>/^angle.*\.(mjs|json)$/.test(file)))
      copy(path.join(native,file),path.join(temporary,'maclauncher/src/modules/android/native',file));
    for(const file of ['source-files.mjs','native-paths.mjs'])
      copy(path.join(native,'upstream',file),path.join(temporary,'maclauncher/src/modules/android/native/upstream',file));
    copy(fileURLToPath(import.meta.url),path.join(temporary,'maclauncher/scripts/build-android-aim.mjs'));
    copy(path.join(repo,'scripts/runtime-content.cjs'),path.join(temporary,'maclauncher/scripts/runtime-content.cjs'));
    copy(path.join(repo,'scripts/android-stage-sources.mjs'),path.join(temporary,'maclauncher/scripts/android-stage-sources.mjs'));
    copy(path.join(repo,'src/modules/android/native/build-sources.mjs'),path.join(temporary,'maclauncher/src/modules/android/native/build-sources.mjs'));
    copy(path.join(repo,'src/modules/shared/runtime/runtime-content.js'),path.join(temporary,'maclauncher/src/modules/shared/runtime/runtime-content.js'));
    copy(path.join(repo,'src/modules/shared/runtime/production-source.js'),path.join(temporary,'maclauncher/src/modules/shared/runtime/production-source.js'));
    copy(path.join(repo,'LICENSE'),path.join(temporary,'maclauncher/LICENSE'));
    ProductionSource.prune(temporary);
    // This module is compiled into the ordinary cargo-aim producer.
    copy(path.join(build,'crates/aim-build/src/test.rs'),path.join(aim,'crates/aim-build/src/test.rs'));
    fs.writeFileSync(path.join(temporary,'README.txt'),'AIM '+source.commit+' with the included MacLauncher source adaptations.\nAOSP source subsets, exact file/tree hashes, build recipes and toolchain pins are included.\nThe original Android SDK image is acquired separately under its own terms; no original image or Google application is included.\nThe aim directory contains the adapted supplier. Build with cargo aim and the pinned SDK/NDK and Rust prerequisites described in aim/docs/build.md.\nThe maclauncher directory contains the owned adaptation and publication sources in their repository layout. Publication uses a full public MacLauncher checkout and node scripts/build-android-aim.mjs --build --stage.\nThe selected ANGLE supplier is recorded in notices/angle/angle-manifest.json. Its owned sources and original Git pins are under maclauncher/src/modules/android/native; stage the produced libraries with --angle and --angle-notices.\n');
    const output=path.join(stage,'files/source.tar.gz');
    archiveAndroidSourceTree(temporary,output);
    return output;
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
}

export function stageAim({build,angle,angleNotices,output}) {
  build=path.resolve(build);angle=path.resolve(angle);angleNotices=path.resolve(angleNotices);output=path.resolve(output);
  const temporary=output+'.stage-'+process.pid;
  fs.rmSync(temporary,{recursive:true,force:true});
  const payload=path.join(temporary,'files');fs.mkdirSync(payload,{recursive:true});
  try {
    const metadata=JSON.parse(run('cargo',['metadata','--format-version','1','--locked'],{cwd:build,encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:32*1024*1024}));
    // cargo-aim compiles host programs here before publishing executable
    // copies. Other source builds may share the public target directory.
    const hostBinaries=path.join(metadata.target_directory,'aim-host-build/release');
    for(const name of binaries) {
      const file=path.join(payload,'bin',name);copy(path.join(hostBinaries,name),file);
      fs.chmodSync(file,0o755);
      run('/usr/bin/strip',['-S',file]);
      // ASIF storage is used by every ordinary launch. Publish that real OS
      // requirement in the executable as well as in the package declaration.
      run('/usr/bin/vtool',['-set-build-version','macos',minimumMacOS,'27.0','-replace','-output',file,file]);
      run('/usr/bin/codesign',['--force','--sign','-',file]);
    }
    for(const file of overlaySources(build,'image/overlay.toml')) copy(path.join(build,file),path.join(payload,file));
    for(const file of appHostFiles) copy(path.join(build,file),path.join(payload,file));
    for(const name of ['libEGL.dylib','libGLESv2.dylib']) copy(path.join(angle,name),path.join(payload,'_build/angle-source/out/AimRelease',name));
    for(const name of ['libMoltenVK.dylib','LICENSE']) copy(path.join(build,'target/aim/moltenvk',name),path.join(payload,'target/aim/moltenvk',name));
    const molten=path.join(payload,'target/aim/moltenvk/libMoltenVK.dylib');
    if(architecture(molten).length>1) run('/usr/bin/lipo',[molten,'-thin','arm64','-output',molten]);
    const notices=[];
    for(const [name,license,from,to,url] of [
      ['AIM','Apache-2.0',path.join(build,'LICENSE'),'notices/aim/LICENSE','https://github.com/hahnlee/aim'],
      ['AIM third-party notices','Multiple',path.join(build,'THIRD_PARTY_NOTICES.md'),'notices/aim/THIRD_PARTY_NOTICES.md','https://github.com/hahnlee/aim'],
      ['AIM licensing exceptions','Multiple',path.join(build,'LICENSING.md'),'notices/aim/LICENSING.md','https://github.com/hahnlee/aim'],
      ['MoltenVK','Apache-2.0',path.join(build,'target/aim/moltenvk/LICENSE'),'notices/moltenvk/LICENSE','https://github.com/KhronosGroup/MoltenVK'],
      ['BoringSSL','ISC AND OpenSSL',path.join(build,'_build/aosp/external/boringssl/src/LICENSE'),'notices/boringssl/LICENSE','https://boringssl.googlesource.com/boringssl'],
    ]) {copy(from,path.join(payload,to));notices.push({name,license,path:to,sourceUrl:url});}
    noticeTree(path.join(build,'licensing'),path.join(payload,'notices/aim/licensing'));
    for(const file of files(path.join(payload,'notices/aim/licensing/third-party'))) notices.push({name:'AIM dependency '+file,license:'See notice',path:'notices/aim/licensing/third-party/'+file,sourceUrl:'https://github.com/hahnlee/aim'});
    noticeTree(angleNotices,path.join(payload,'notices/angle'));
    const angleManifest=path.join(angle,'angle-manifest.json');
    if(fs.existsSync(angleManifest))copy(angleManifest,path.join(payload,'notices/angle/angle-manifest.json'));
    for(const file of files(angleNotices).filter(name=>name.endsWith('.txt'))) notices.push({name:'ANGLE '+file,license:'See notice',path:'notices/angle/'+file,sourceUrl:'https://chromium.googlesource.com/angle/angle'});
    // Rust crate notices cover statically linked registry code too. Cargo's
    // locked metadata identifies the exact supplier for every included text.
    for(const pkg of metadata.packages.filter(pkg=>pkg.source?.startsWith('registry+'))) {
      const directory=path.dirname(pkg.manifest_path);
      for(const name of fs.readdirSync(directory).filter(file=>/^(LICENSE|COPYING|NOTICE|COPYRIGHT)(?:$|[-_.])/i.test(file)&&fs.statSync(path.join(directory,file)).isFile())) {
        const relative=`notices/rust/${pkg.name}-${pkg.version}/${name}`;copy(path.join(directory,name),path.join(payload,relative));
        notices.push({name:pkg.name+' '+pkg.version,license:pkg.license||'See notice',path:relative,sourceUrl:`https://crates.io/crates/${pkg.name}/${pkg.version}`});
      }
    }
    correspondingSource(build,temporary);
    for(const file of files(payload)) {
      const full=path.join(payload,file),arch=architecture(full);
      fs.chmodSync(full,arch||(fs.statSync(full).mode&0o111)?0o755:0o644);
      if(arch) run('/usr/bin/codesign',['--force','--sign','-',full]);
    }
    const records=inventory(payload),dependencies=[];
    for(const file of records.filter(file=>file.architectures)) {
      const full=path.join(payload,file.path),lines=run('/usr/bin/otool',['-L',full],{encoding:'utf8',stdio:['ignore','pipe','inherit']}).split('\n').slice(1).filter(Boolean);
      const links=lines.map(line=>line.trim().split(' (compatibility')[0]);
      if(file.path.endsWith('.dylib')) links.shift();
      for(const link of links) if(!link.startsWith('/usr/lib/')&&!link.startsWith('/System/Library/')&&!link.startsWith('@loader_path/')) throw new Error('Unresolved native dependency '+file.path+': '+link);
      dependencies.push({file:file.path,links});
    }
    // The supplier derives these transactions from pinned AIDL and verifies
    // them against the original image. Keep the selected runtime's ABI.
    const aidl=fs.readFileSync(path.join(build,'target/aim/gen/service-aidl/lib.rs'),'utf8');
    const unlockCodes=[...aidl.matchAll(/pub const IS_USER_UNLOCKING_OR_UNLOCKED: u32 = (\d+);/g)];
    if(unlockCodes.length!==1)throw new Error('AIM user-state transaction is unavailable.');
    const appHostUserUnlockTransaction=Number(unlockCodes[0][1]);
    const manifest={schemaVersion:1,managerId:'android-aim',version:source.version,upstreamRevision:source.commit,platform:'darwin',arch:'arm64',minimumMacOS,capabilities:{appHost:true,appHostUserUnlockTransaction},
      executableRelative:'bin/aimctl',files:records,notices,dependencies,provenance:{sourceRevision:source.commit,verifiedBuild:true}};
    B.validateManifest(manifest);B.verifyPayload(payload,manifest);
    fs.writeFileSync(path.join(temporary,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    const declaration={id:'android-aim',version:source.version,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS,directoryRelative:`android-aim/${source.version}/arm64`,
      manifestRelative:'manifest.json',manifestSha256:sha(path.join(temporary,'manifest.json')),sourceRelative:'files/source.tar.gz',sourceSha256:sha(path.join(payload,'source.tar.gz')),
      files:inventory(temporary),notices:notices.map(notice=>({...notice,path:'files/'+notice.path})),redistribution:'bundle'};
    Supplemental.validateDeclaration(declaration);
    fs.mkdirSync(path.dirname(output),{recursive:true});
    const previous=output+'.previous-'+process.pid;
    if(fs.existsSync(output)) fs.renameSync(output,previous);
    try { fs.renameSync(temporary,output); }
    catch(error) { if(fs.existsSync(previous)) fs.renameSync(previous,output);throw error; }
    fs.rmSync(previous,{recursive:true,force:true});
    fs.writeFileSync(path.join(repo,'src/modules/android/aim-distribution.json'),JSON.stringify([declaration],null,2)+'\n');
    return {output,declaration};
  } catch(error) {fs.rmSync(temporary,{recursive:true,force:true});throw error;}
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),value=(flag,fallback)=>{const at=args.indexOf(flag);return at<0?fallback:args[at+1];};
  const build=path.resolve(value('--work',path.join(os.homedir(),'Library/Caches/maclauncher/android-aim-build/upstream')));
  if(args.includes('--prepare')||args.includes('--build')) prepareAimSources({checkout:path.join(repo,'src/external/aim'),output:build});
  // Publish the overlay's inputs. The app prepares its shared system image
  // during Play, so a build needs no additional mounted derived-image copy.
  if(args.includes('--build')) run('cargo',['aim','build',...binaries.map(name=>'host/'+name),
    ...imageProducts],{cwd:build,env:{...process.env,MACLAUNCHER_AIM_ROOT:build,
    RUSTFLAGS:[process.env.RUSTFLAGS,`--remap-path-prefix=${build}=/aim`,`--remap-path-prefix=${repo}=/maclauncher`].filter(Boolean).join(' '),CARGO_PROFILE_RELEASE_STRIP:'none'}});
  if(args.includes('--stage')) {
    const angle=value('--angle'),angleNotices=value('--angle-notices');
    if(!angle||!angleNotices) throw new Error('Staging needs --angle and --angle-notices for the pinned ANGLE supplier.');
    const output=path.join(repo,'src/resources/native-runtimes/android-aim',source.version,'arm64');
    const staged=stageAim({build,angle,angleNotices,output});
    console.log(JSON.stringify({output:staged.output,files:staged.declaration.files.length,bytes:staged.declaration.files.reduce((total,file)=>total+file.size,0),minimumMacOS}));
  }
}
