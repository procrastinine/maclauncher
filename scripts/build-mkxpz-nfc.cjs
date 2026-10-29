// Maintainer source build. Ordinary Play uses the sealed Included artifact.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {execFileSync} = require('node:child_process');
const Native = require('../src/modules/shared/runtime/local-native');
const B = require('../src/modules/shared/runtime/bundled-native');
const Overlay = require('../src/modules/rgss/overlays/mkxpz-filename-nfc/source.json');
const {loadCommands, links} = require('./native-binary-tools.cjs');
const Content = require('./runtime-content.cjs');
const SOURCE_SHA256 = '364394e8cb3089b1f5adb12a4ab524770e743bf3973ec53e8f411ba5e11886d6';
const VERSION = 'MCLv1-1003';
const overlayDirectory = path.resolve(__dirname, '../src/modules/rgss/overlays/mkxpz-filename-nfc');
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:DYLD_|RESHADE_|MACFX_|MACLAUNCHER_GRAPHICS)/.test(key) &&
  !['CFLAGS','CXXFLAGS','CPPFLAGS','LDFLAGS','OBJCFLAGS','OBJCXXFLAGS'].includes(key)));
function run(command, args, options = {}) { return execFileSync(command, args, {stdio: 'inherit',
  env: {...environment(), PATH: path.dirname(command) + path.delimiter + process.env.PATH}, ...options}); }
function verifySource(source) {
  for (const item of Overlay.files) if (Native.hashFile(path.join(source, item.path)) !== item.adaptedSha256)
    throw new Error('The MKXP-Z source adaptation changed: ' + item.path);
  for (const item of Overlay.addedFiles) if (Native.hashFile(path.join(source, item.destination)) !== item.sha256)
    throw new Error('The MKXP-Z added source changed: ' + item.destination);
}
function prepareSource(archive, work) {
  if (Native.hashFile(archive) !== SOURCE_SHA256) throw new Error('Choose the pinned original MKXP-Z source archive.');
  const source = path.join(work, 'source');
  if (!fs.existsSync(source)) {
    fs.mkdirSync(source, {recursive: true});
    run('/usr/bin/tar', ['-xzf', archive, '--strip-components=1', '-C', source]);
  }
  const first = Overlay.files[0];
  if (Native.hashFile(path.join(source, first.path)) === first.originalSha256) {
    for (const item of Overlay.files) if (Native.hashFile(path.join(source, item.path)) !== item.originalSha256)
      throw new Error('The original MKXP-Z source differs from its pin.');
    if (Native.hashFile(path.join(overlayDirectory, Overlay.patch.file)) !== Overlay.patch.sha256) throw new Error('The MKXP-Z source patch changed.');
    run('/usr/bin/patch', ['--batch', '--fuzz=0', '-p1', '-i', path.join(overlayDirectory, Overlay.patch.file)], {cwd: source});
    for (const item of Overlay.addedFiles) fs.copyFileSync(path.join(overlayDirectory, item.file), path.join(source, item.destination));
  }
  verifySource(source);
  const revisionFile=path.join(source,'git-hash'),revision=Overlay.upstream.revision+'\n';
  if(!fs.existsSync(revisionFile)||fs.readFileSync(revisionFile,'utf8')!==revision)fs.writeFileSync(revisionFile,revision);
  return source;
}

function configure({work, source, meson}) {
  const native = path.join(work, 'arm64.ini'), build = path.join(work, 'build');
  // ANGLE's X11 auto predicate becomes true with both desktop GL and Vulkan
  // disabled. Darwin uses its Metal backend and has no X11/Wayland sources.
  const options = ['-Dstrip=true', '-Db_lto=false', '-Dangle_vulkan=disabled', '-Dangle_direct3d11=disabled',
    '-Dangle:x11=disabled', '-Dangle:wayland=disabled'];
  const tool = compiler => "['" + compiler + "', '--target=arm64-apple-macos11.0']";
  if (!fs.existsSync(native)) fs.writeFileSync(native, '[binaries]\n' + ['c', 'cpp', 'objc', 'objcpp'].map(kind =>
    kind + ' = ' + tool(kind === 'cpp' || kind === 'objcpp' ? 'clang++' : 'clang')).join('\n') +
    '\n\n[built-in options]\n' + ['c','cpp','objc','objcpp'].map(kind=>kind+"_args = ['-mmacosx-version-min=11.0']").join('\n')+'\n');
  if (!fs.existsSync(path.join(build, 'meson-private/coredata.dat')))
    run(meson, ['setup', build, source, '--native-file', native, '--prefix', '/usr/local', '--buildtype', 'release',
      ...options],
      {env: {...environment(), PATH: path.dirname(meson) + path.delimiter + process.env.PATH}});
  else {
    const current = JSON.parse(fs.readFileSync(path.join(build, 'meson-info/intro-buildoptions.json'), 'utf8'));
    if (['angle:x11', 'angle:wayland'].some(name => current.find(item => item.name === name)?.value !== 'disabled') ||
        current.find(item => item.name === 'prefix')?.value !== '/usr/local')
      run(meson, ['configure', build, '--prefix', '/usr/local', ...options]);
  }
  return build;
}

function sourceArchive(source, output, work) {
  // The upstream Mesa overlay only declares headers; none of its renderer
  // sources are built. Preserve every declared include root and its notices.
  const mesa = 'subprojects/mesa-26.0.3/';
  const list = [], skip = name => name.split('/').some(part => ['.git', '__pycache__', 'packagecache', 'AGENTS.md'].includes(part)) ||
    /^subprojects\/ruby-3_1_3\/test(?:\/|$)/.test(name) ||
    /^subprojects\/(?:SDL_ttf-release-2\.0\.18|sdl2_image)\/Xcode\/(?:macOS|iOS|tvOS)\/SDL2\.framework(?:\/|$)/.test(name) ||
    /(?:^|\/)\.DS_Store$|\.(?:pyc|pyo)$/.test(name) || name.startsWith(mesa) &&
    !/^(?:include(?:\/|$)|src(?:$|\/gbm(?:\/|$))|meson\.build$|meson_options\.txt$|meson\.options$|COPYING[^/]*$|LICENSE[^/]*$)/.test(name.slice(mesa.length));
  function walk(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (skip(name)) continue;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), name);
      else if (entry.isFile() || entry.isSymbolicLink()) list.push(name);
      else throw new Error('Unsupported source file type.');
    }
  }
  walk(source);
  const file = path.join(work, 'source-files.txt'); fs.writeFileSync(file, list.join('\n') + '\n');
  // Complete corresponding source is a separate release input, never app data.
  run('/usr/bin/tar', ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'wheel', '--no-xattrs', '--no-acls',
    '-czf', output, '-C', source, '--no-recursion', '-T', file]);
}

function stage({work, source, output}) {
  verifySource(source);
  const installed = path.join(work, 'install/usr/local'), apps = fs.readdirSync(installed).filter(name => name.endsWith('.app'));
  if (apps.length !== 1) throw new Error('The MKXP-Z build must install exactly one app.');
  const directory = path.join(output, 'mkxpz', VERSION, 'arm64'), payload = path.join(directory, 'files');
  if (fs.existsSync(directory)) throw new Error('Choose a new MKXP-Z publication; existing artifacts are never overwritten.');
  fs.mkdirSync(payload, {recursive: true});
  const inventory = [], notices = [];
  function copy(from, relative) {
    const stat = fs.lstatSync(from);
    if (Content.excludedReason(relative)) return;
    if (stat.isDirectory()) { for (const item of fs.readdirSync(from).sort()) copy(path.join(from, item), relative ? relative + '/' + item : item); return; }
    if (!stat.isFile()) throw new Error('MKXP-Z runtime inputs must be regular files.');
    const target = path.join(payload, relative); fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(from, target, fs.constants.COPYFILE_FICLONE || 0); fs.chmodSync(target, stat.mode & 0o111 ? 0o755 : 0o644);
    // Ruby's developer metadata includes its staging directory. Keep the
    // relocatable runtime fields and describe build inputs at a logical path.
    if (relative.startsWith('stdlib/') && path.basename(relative) === 'rbconfig.rb')
      fs.writeFileSync(target,fs.readFileSync(target,'utf8').split(work).join('/usr/local/src/mkxpz'),{mode:0o644});
  }
  for (const name of fs.readdirSync(installed).sort()) copy(path.join(installed, name), name);
  const sourceNotice = path.join(payload, 'licenses/SOURCE.txt'); fs.mkdirSync(path.dirname(sourceNotice), {recursive: true});
  fs.writeFileSync(sourceNotice, 'MKXP-Z '+Overlay.upstream.revision+' with MacLauncher '+Overlay.id+'\n'+Overlay.upstream.repository+'\n', {mode: 0o644});
  notices.push({name:'MKXP-Z with macOS filename normalization',license:'GPL-3.0-or-later',path:'LICENSE.txt',sourceUrl:Overlay.upstream.repository});
  function collectNotices(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
      if (['.git', 'packagecache', '__pycache__'].includes(entry.name)) continue;
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { if (!Content.excludedReason(name)) collectNotices(path.join(directory,entry.name),name); }
      else if (entry.isFile() && /^(?:COPYING|LICENSE|NOTICE)(?:[.-].*)?$/i.test(entry.name)) {
        const target = 'licenses/dependencies/' + name; copy(path.join(directory,entry.name),target);
        notices.push({name:'Included dependency '+relative,license:'Included license notice',path:target,
          sourceUrl:Overlay.upstream.repository+'/tree/'+Overlay.upstream.revision+'/subprojects'});
      }
    }
  }
  collectNotices(path.join(source,'subprojects'));
  const executableRelative = apps[0] + '/Contents/MacOS/bundle_mkxp-z';
  run('/usr/bin/codesign', ['--force','--sign','-',path.join(payload,apps[0])]);
  run('/usr/bin/codesign', ['--verify','--deep','--strict',path.join(payload,apps[0])]);
  for (const relative of B.fileInventory(payload)) {
    const file = path.join(payload,relative), stat = fs.lstatSync(file); let architectures;
    try { architectures = Native.readMachOArchitectures(file,{allowLibrary:true}); } catch {}
    if (architectures) {
      if (JSON.stringify(architectures) !== JSON.stringify(['arm64']) || loadCommands(file).minimumMacOS !== '11.0')
        throw new Error('The MKXP-Z build has unexpected CPU or macOS requirements.');
      if (links(file).some(link => !link.startsWith('/System/Library/') && !link.startsWith('/usr/lib/')))
        throw new Error('The MKXP-Z build has an external dynamic dependency.');
    }
    inventory.push({path:relative,size:stat.size,mode:stat.mode&0o777,sha256:Native.hashFile(file),...(architectures?{architectures}:{})});
  }
  const sourceRelative = 'mkxpz/' + VERSION + '-source.tar.gz', archive = path.join(output,sourceRelative);
  sourceArchive(source,archive,work); fs.chmodSync(archive,0o644);
  const sourceArtifact = {directoryRelative:sourceRelative,sha256:Native.hashFile(archive),bytes:fs.statSync(archive).size};
  const manifest = {schemaVersion:1,managerId:'mkxpz',version:VERSION,upstreamRevision:Overlay.upstream.revision,platform:'darwin',arch:'arm64',minimumMacOS:'11.0',
    executableRelative,files:inventory,notices,dependencies:[],provenance:{sourceKind:'owned-source-adaptation',verifiedBuild:true,sourceRevision:Overlay.upstream.revision,
      adaptationId:Overlay.id,patchSha256:Overlay.patch.sha256,headerSha256:Overlay.addedFiles[0].sha256,implementationSha256:Overlay.addedFiles[1].sha256,sourceArchiveSha256:SOURCE_SHA256,
      compiler:execFileSync('/usr/bin/xcrun',['clang','--version'],{encoding:'utf8'}).split('\n')[0]}};
  B.validateManifest(manifest); B.verifyPayload(payload,manifest);
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(path.join(directory,'manifest.json'),bytes,{flag:'wx',mode:0o644});
  const declaration={id:'mkxpz',version:VERSION,arch:'arm64',launcherArchitectures:['arm64'],minimumMacOS:'11.0',directoryRelative:'mkxpz/'+VERSION+'/arm64',
    manifestRelative:'manifest.json',manifestSha256:B.digest(bytes),sourceSha256:sourceArtifact.sha256,sourceArtifact,
    files:[...inventory.map(file=>({...file,path:'files/'+file.path})),{path:'manifest.json',size:bytes.length,mode:0o644,sha256:B.digest(bytes)}],
    notices:notices.map(notice=>({...notice,path:'files/'+notice.path}))};
  const pin={version:VERSION,arch:'arm64',minimumMacOS:'11.0',appName:apps[0],executableRelative,upstreamRevision:Overlay.upstream.revision,
    sourceUrl:Overlay.upstream.repository+'/tree/'+Overlay.upstream.revision,sourceKind:'owned-source-adaptation',adaptationId:Overlay.id,
    patchSha256:Overlay.patch.sha256,headerSha256:Overlay.addedFiles[0].sha256,implementationSha256:Overlay.addedFiles[1].sha256,
    label:'20261003 · NFC 1 · Apple Silicon',executableSha256:inventory.find(file=>file.path===executableRelative).sha256,sourceArtifact};
  return {pin,declaration,directory,sourceArtifact};
}

function main(args) {
  const inputs={}; for(let index=0;index<args.length;index+=2){const key=args[index]?.slice(2),value=args[index+1];
    if(!args[index]?.startsWith('--')||!['work','archive','meson','ninja','output'].includes(key)||!path.isAbsolute(value||'')||inputs[key])throw new Error('Choose absolute --work, --archive, --meson, --ninja and --output paths.');inputs[key]=value;}
  if(Object.keys(inputs).length!==5)throw new Error('Missing MKXP-Z source build inputs.');
  const source=prepareSource(inputs.archive,inputs.work),build=configure({...inputs,source});
  const rubyBuild=path.join(build,'subprojects/ruby-3_1_3/build'),rubyStamp=path.join(inputs.work,'ruby-adaptation.json');
  const rubyIdentity=Overlay.files.find(file=>file.path==='subprojects/packagefiles/ruby-3.1/meson.build').adaptedSha256;
  if (fs.existsSync(path.join(rubyBuild,'Makefile')) &&
      (!fs.existsSync(rubyStamp) || fs.readFileSync(rubyStamp,'utf8') !== rubyIdentity)) {
    // Ruby's Makefiles do not invalidate extension objects after flag changes.
    run('/usr/bin/make',['clean'],{cwd:rubyBuild});
    fs.writeFileSync(rubyStamp,rubyIdentity);
  }
  run(inputs.ninja,['-C',build,'-j',String(Math.min(6,os.availableParallelism())),'bundle_mkxp-z']);
  run(inputs.meson,['install','-C',build,'--no-rebuild','--tags','mkxp-z-bundle'],
    {env:{...environment(),PATH:path.dirname(inputs.meson)+path.delimiter+process.env.PATH,DESTDIR:path.join(inputs.work,'install')}});
  const result=stage({...inputs,source});fs.writeFileSync(path.join(inputs.work,'STAGED.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
if(require.main===module)main(process.argv.slice(2));
module.exports={VERSION,SOURCE_SHA256,prepareSource,verifySource,configure,sourceArchive,stage};
