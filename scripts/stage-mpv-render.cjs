// Build an owned GPU render host around an explicit, unchanged libmpv input.
// The result is a managed media runtime, separate from launcher resources.
const fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process');
const Native = require('../src/modules/shared/runtime/local-native');
const Stage = require('./native-binary-tools.cjs');
const {versionAtLeast} = require('../src/modules/shared/runtime/bundled-native');
const root = path.resolve(__dirname, '..');
const sourceFiles = ['mpv-render.mm', 'gpu-surface.mm', 'gpu-surface.hpp', 'mpv-frame-metadata.h'];
const headerFiles = ['frame.h','presentation.h','presentation-content.h','presentation-observed.h','presentation-source.h','target-time.h','image-color.h'].map(file=>'src/modules/shared/reshade/native/'+file);
const run = (command, args) => execFileSync(command, args, {encoding:'utf8',stdio:'pipe',timeout:120000});
function stage({library,referenceExecutable,dependencyRoots=[],output,version,source,notices,arch=process.arch,minimumMacOS='14.0'}) {
  if(process.platform!=='darwin'||!['arm64','x64'].includes(arch))throw Error('Choose a supported native Mac architecture.');
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version||'')||!/^\d+\.\d+$/.test(minimumMacOS))throw Error('An explicit runtime version and macOS floor are required.');
  if(!source||!/^https:\/\//.test(source.url||'')||!/^[a-f0-9]{40}$/.test(source.commit||'')||!source.version||!Array.isArray(notices)||!notices.length)throw Error('The library source identity and original notices are required.');
  library=fs.realpathSync(library);referenceExecutable=fs.realpathSync(referenceExecutable);output=path.resolve(output);
  if(fs.existsSync(output))throw Error('Choose an empty output; managed runtime inputs are never modified.');
  const cpu=arch==='x64'?'x86_64':arch,images=new Map(),targets=new Map(),originalHashes=new Map(),included=[],noticeRoots=new Set();
  let effectiveMinimum=minimumMacOS;
  const app=path.join(output,'mpv.app'),executable=path.join(app,'Contents/MacOS/mpv'),libraries=path.join(app,'Contents/Frameworks/video');
  fs.mkdirSync(path.dirname(executable),{recursive:true});fs.mkdirSync(libraries,{recursive:true});fs.mkdirSync(path.join(app,'Contents/Resources'),{recursive:true});
  try {
    const inherited=Stage.loadCommands(referenceExecutable,cpu).rpaths;
    function copy(original,name=path.basename(original)) {
      original=fs.realpathSync(original);if(targets.has(original))return targets.get(original);
      const target=path.join(libraries,name),sha256=Native.hashFile(original);
      if(fs.existsSync(target)&&Native.hashFile(target)!==sha256)throw Error('Conflicting media library basenames.');
      fs.copyFileSync(original,target,fs.constants.COPYFILE_FICLONE);fs.chmodSync(target,0o755);
      targets.set(original,target);images.set(target,original);originalHashes.set(original,sha256);return target;
    }
    const primary=copy(library,'libmpv.2.dylib'),queue=[primary],processed=new Set();
    for(let n=0;n<queue.length;n++) {
      const target=queue[n];if(processed.has(target))continue;processed.add(target);
      const original=images.get(target),commands=Stage.loadCommands(original,cpu),ids=Stage.libraryIds(original,cpu);
      if(!Native.readMachOArchitectures(original,{allowLibrary:true}).includes(cpu))throw Error('A media dependency does not contain the selected CPU slice.');
      if(Native.readMachOArchitectures(target,{allowLibrary:true}).length>1) {
        const thin=target+'.thin';run('/usr/bin/lipo',['-thin',cpu,target,'-output',thin]);fs.renameSync(thin,target);
      }
      for(const link of Stage.links(original,cpu)) {
        if(link.startsWith('/System/Library/')||link.startsWith('/usr/lib/')||ids.includes(link))continue;
        const candidates=dependencyRoots.map(directory=>path.join(directory,path.basename(link)));
        const dependency=candidates.find(file=>fs.existsSync(file))||Stage.resolveLink(link.replace('@@HOMEBREW_PREFIX@@',arch==='arm64'?'/opt/homebrew':'/usr/local'),original,referenceExecutable,[...commands.rpaths,...inherited],cpu);
        const copied=copy(dependency,path.basename(link));
        run('/usr/bin/install_name_tool',['-change',link,'@loader_path/'+path.basename(copied),target]);queue.push(copied);
      }
      for(const rpath of commands.rpaths)if(rpath.startsWith('/')&&!rpath.startsWith('/System/Library/'))run('/usr/bin/install_name_tool',['-delete_rpath',rpath,target]);
      run('/usr/bin/install_name_tool',['-id','@rpath/'+path.basename(target),target]);
      run('/usr/bin/codesign',['--force','--sign','-',target]);
      const floor=Stage.loadCommands(target,cpu).minimumMacOS;
      if(!floor)throw Error('A media dependency has no declared macOS deployment target.');
      if(!versionAtLeast(effectiveMinimum,floor))effectiveMinimum=floor;
      Stage.addDependencyNotices(original,output,included,noticeRoots,path.join(output,'.build-records'));
    }
    const flags=['clang++','-std=c++17','-O2','-fobjc-arc','-Wno-deprecated-declarations','-arch',cpu,'-mmacosx-version-min='+minimumMacOS,
      '-ffile-prefix-map='+root+'=.','-I'+path.join(root,'src/external/mpv-player/include'),
      '-I'+path.join(root,'src/modules/shared/reshade/native')];
    run('/usr/bin/xcrun',[...flags,...['mpv-render.mm','gpu-surface.mm'].map(file=>path.join(root,'src/modules/video/native',file)),
      ...['AppKit','Metal','QuartzCore','OpenGL','CoreVideo','IOSurface'].flatMap(name=>['-framework',name]),
      '-Wl,-rpath,@executable_path/../Frameworks/video','-o',executable]);
    run('/usr/bin/codesign',['--force','--sign','-',executable]);
    const info=JSON.parse(run(executable,['--maclauncher-info']));
    if(info.schema!==1||info.decodedFrameAPI!==1||info.decodedColorAPI!==1||info.preparationNotificationAPI!==1||info.osdLayerAPI!==1||!String(info.libraryVersion).includes(source.version))throw Error('The prepared media library differs from its selected version or lacks separate video and OSD output.');
    const licenseDirectory=path.join(output,'licenses');fs.mkdirSync(licenseDirectory,{recursive:true});
    included.push(...notices.map((notice,index)=>{
      const destination=path.join(licenseDirectory,index+'-'+path.basename(notice.file));fs.copyFileSync(notice.file,destination);
      return {name:notice.name,license:notice.license,path:path.relative(output,destination),sha256:Native.hashFile(destination),...(notice.sourceUrl?{sourceUrl:notice.sourceUrl}:{})};
    }));
    const plist='<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.maclauncher.video</string><key>CFBundleName</key><string>Video</string><key>CFBundleExecutable</key><string>mpv</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>'+source.version+'</string><key>LSMinimumSystemVersion</key><string>'+effectiveMinimum+'</string><key>NSHighResolutionCapable</key><true/></dict></plist>';
    fs.writeFileSync(path.join(app,'Contents/Info.plist'),plist);
    run('/usr/bin/codesign',['--force','--sign','-',app]);run('/usr/bin/codesign',['--verify','--strict','--deep',app]);
    const metadata={schema:1,id:'mpv-render',version,minimumMacOS:effectiveMinimum,architecture:cpu,decodedFrameAPI:1,decodedColorAPI:1,preparationNotificationAPI:1,
      ...(info.playerScriptsAPI===1?{playerScriptsAPI:1}:{}),...(info.playerInputAPI===1?{playerInputAPI:1}:{}),osdLayerAPI:1,libraryVersion:info.libraryVersion,
      intermediateColor:{primaries:'bt2020',transfer:'pq',referenceWhite:203,encodingPeak:10000,format:'rgba16float'},
      outputColor:{primaries:'display-p3',transfer:'linear',format:'rgba16float',headroom:'display'},
      scaleFilters:info.scaleFilters,librarySource:{...source,inputSha256:originalHashes.get(library),verifiedBuild:source.build?.librarySha256===originalHashes.get(library)},
      headerSource:{repository:'https://github.com/mpv-player/mpv.git',commit:'41f6a645068483470267271e1d09966ca3b9f413'},
      ownedSources:sourceFiles.map(file=>({file,sha256:Native.hashFile(path.join(root,'src/modules/video/native',file))})),
      ownedHeaders:headerFiles.map(file=>({file,sha256:Native.hashFile(path.join(root,file))})),
      images:[{path:path.relative(output,executable),sha256:Native.hashFile(executable)},...[...processed].map(target=>({path:path.relative(output,target),sha256:Native.hashFile(target),inputSha256:originalHashes.get(images.get(target))}))],notices:included};
    fs.writeFileSync(path.join(output,'video-runtime.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx'});
    for(const [original,sha256] of originalHashes)if(Native.hashFile(original)!==sha256)throw Error('An original media input changed during staging.');
    fs.rmSync(path.join(output,'.build-records'),{recursive:true,force:true});return metadata;
  } catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
if(require.main===module){const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--config')throw Error('Usage: node scripts/stage-mpv-render.cjs --config /path/to/input.json');console.log(JSON.stringify(stage(JSON.parse(fs.readFileSync(args[1],'utf8'))),null,2));}
module.exports={stage};
