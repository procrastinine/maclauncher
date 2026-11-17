const {createProjectBuildManager} = require('../shared/runtime/project-build-manager');
const Bundled = require('../shared/runtime/bundled-native');
const fs=require('node:fs'),path=require('node:path'),Custom=require('../shared/runtime/custom-runtime');
const {readMachOLoadCommands,assertSystemLibraryClosure}=require('../shared/runtime/macho-load-commands');
function createManager(dependencies = {}) {
  const manager = createProjectBuildManager({projectId:'android-art-image-extractor', runtimeId:'android-image-extractor',
    label:'Android image reader', repository:'procrastinine/maclauncher-builds', upstreamUrl:'https://github.com/hahnlee/aim',
    manifestRelative:'manifest.json', filesPrefix:'files/', executableRelative:'bin/android-image-extract',
    versionCompatibility:()=>true,verifyPayload:selected=>Bundled.verifyPayload(selected.root,selected.declaration,selected.resolveDependency),dependencies});
  manager.ui = {groupId:'tools',tabLabel:'Tools',sectionLabel:'Android image reader',order:200,memberOrder:279,management:'managed'};
  const inspectPackage=manager.customRuntime.inspect;
  Custom.configure(manager,{inspect(input,context){
    let directory=fs.statSync(input).isDirectory()?input:path.dirname(input);
    for(let depth=0;depth<7;depth++){
      const file=path.join(directory,'manifest.json');
      if(fs.existsSync(file)){
        const manifest=JSON.parse(Bundled.readRegular(file,Bundled.LIMITS.manifestBytes).bytes);
        if(manifest.managerId===manager.id||manifest.id===manager.id)return inspectPackage(input,context);
      }
      if(path.dirname(directory)===directory)break;directory=path.dirname(directory);
    }
    const native=Custom.inspectNative(input,{candidates:['android-image-extract','bin/android-image-extract']});
    if(path.basename(native.executablePath)!=='android-image-extract')throw Error('Select the Android image reader executable or its complete package.');
    assertSystemLibraryClosure(readMachOLoadCommands(native.executablePath,{architecture:native.architecture==='x64'?'x86_64':native.architecture}),
      {fileType:2,maximumMacOS:(dependencies.systemVersionSync||Bundled.systemVersionSync)()});
    return native;
  }});
  return manager;
}
module.exports = Object.assign(createManager(), {createManager});
