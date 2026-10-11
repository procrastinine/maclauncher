const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const Pinned = require('../../runtime/pinned-native-build');

const VERSION = '1.10-dev-6e9e34ed-macos-v1';
const REVISION = '6e9e34ed0876014fdb46e684103ef8c3605e382e';
const BOOST_VERSION = '1.92.0';
const DEPENDENCIES = Object.freeze({
  'boost-filesystem': 'd73863751bf0570fc82f1b49246f909cea61083b',
  'boost-program-options': 'ae25c112b7032d288df90be95e10876ece30bee3',
  'boost-iostreams': 'dacdb3db57e9f372ad575f02a45b5efb439d8889'
});
const NATIVE = path.join(__dirname, '../native');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function patch(file, before, after) {
  const value=fs.readFileSync(file,'utf8');
  if(!value.includes(before)||value.indexOf(before)!==value.lastIndexOf(before))throw Error('Pinned Inno build overlay differs: '+path.basename(file));
  fs.writeFileSync(file,value.replace(before,()=>after));
}
function adaptSource(stage) {
  const root=fs.realpathSync(stage),external=path.resolve(__dirname,'../../../../external');
  if(root===external||root.startsWith(external+path.sep))throw Error('External installer sources are read-only');
  patch(path.join(root,'CMakeLists.txt'),'find_package(Boost REQUIRED COMPONENTS\n\tiostreams\n\tfilesystem\n\tdate_time\n\tsystem\n\tprogram_options\n)',
    'include("${CMAKE_CURRENT_SOURCE_DIR}/maclauncher-static-dependencies.cmake")');
  patch(path.join(root,'src/setup/info.cpp'),'\tresult.clear();\n\tif(entries & entry_type) {',
    '\tif(count > 100000) throw std::runtime_error("Installer entry limit exceeded");\n\tresult.clear();\n\tif(entries & entry_type) {');
  patch(path.join(root,'src/util/load.cpp'),'\ttarget.clear();\n\t\n\twhile(length) {',
    '\tif(length > 8 * 1024 * 1024) throw std::runtime_error("Installer string limit exceeded");\n\ttarget.clear();\n\t\n\twhile(length) {');
  patch(path.join(root,'src/util/load.cpp'),'\t\tis.read(buffer, std::streamsize(buf_size));\n\t\ttarget.append(buffer, buf_size);',
    '\t\tis.read(buffer, std::streamsize(buf_size));\n\t\tif(is.fail()) throw std::runtime_error("Installer string is truncated");\n\t\ttarget.append(buffer, buf_size);');
  const inspector=fs.readFileSync(path.join(NATIVE,'inno-inspect.cpp'));
  fs.writeFileSync(path.join(root,'maclauncher-inno-inspect.cpp'),inspector);
  fs.copyFileSync(path.join(NATIVE,'static-dependencies.cmake'),path.join(root,'maclauncher-static-dependencies.cmake'));
  fs.appendFileSync(path.join(root,'CMakeLists.txt'),'\n# MacLauncher owned JSON inspection companion.\nset(MACLAUNCHER_INSPECT_SOURCES ${INNOEXTRACT_SOURCES})\nlist(REMOVE_ITEM MACLAUNCHER_INSPECT_SOURCES src/cli/main.cpp)\nadd_executable(maclauncher-inno-inspect maclauncher-inno-inspect.cpp ${MACLAUNCHER_INSPECT_SOURCES})\ntarget_link_libraries(maclauncher-inno-inspect ${LIBRARIES})\ninstall(TARGETS maclauncher-inno-inspect RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})\n');
}
async function buildCandidate({directory,sourceDir,dependencyDirs,boostHeaders,signal,logger=console}={}) {
  if(process.platform!=='darwin'||!path.isAbsolute(directory||''))throw Error('A separate absolute Mac installer build directory is required');
  const dirs={innoextract:sourceDir,...dependencyDirs},pins={innoextract:REVISION,...DEPENDENCIES};
  for(const source of Object.values(dirs)) {
    if(!path.isAbsolute(source||'')||source===directory||source.startsWith(directory+path.sep)||directory.startsWith(source+path.sep))throw Error('Installer source and owned build directories must be separate');
  }
  const sources=await Promise.all(Object.entries(pins).map(async([name,revision])=>[name,await Pinned.validatePinnedSource(dirs[name],revision,{signal})]));
  const stage=path.join(directory,'build-source'),upstream=path.join(stage,'innoextract'),deps=path.join(stage,'dependencies'),output=path.join(directory,'build-output'),payload=path.join(directory,'payload');
  if(fs.existsSync(stage)||fs.existsSync(output)||fs.existsSync(payload))throw Error('The candidate stage already exists; preserve it and use a fresh directory');
  const sourceTrees={};
  for(const[name,verified]of sources)sourceTrees[name]=Pinned.stagePinnedFiles(dirs[name],verified.files,name==='innoextract'?upstream:path.join(deps,name));
  const header=fs.readFileSync(path.join(boostHeaders,'boost/version.hpp'),'utf8');
  if(!/#define BOOST_VERSION 109200\b/.test(header))throw Error('Choose the pinned Boost 1.92 header SDK');
  adaptSource(upstream);
  const sdk=cp.execFileSync('/usr/bin/xcrun',['--show-sdk-path'],{encoding:'utf8',timeout:10000}).trim();
  const quote=v=>"'"+v.replace(/'/g,"'\\''")+"'";
  const mappings=[[directory,'maclauncher-build/innoextract/'+VERSION],[upstream,'src/external/innoextract'],[deps,'src/external/innoextract-dependencies']];
  const flags=mappings.flatMap(([from,to])=>['file','debug','macro'].map(kind=>'-f'+kind+'-prefix-map='+quote(from+'='+to))).join(' ');
  const options=['-DCMAKE_BUILD_TYPE=Release','-DCMAKE_POLICY_VERSION_MINIMUM=3.10','-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0','-DCMAKE_OSX_SYSROOT='+sdk,'-DCMAKE_CXX_STANDARD=20','-DCMAKE_CXX_FLAGS='+flags,
    '-DCMAKE_INSTALL_PREFIX='+payload,'-DMACLAUNCHER_BOOST_HEADERS='+boostHeaders,'-DMACLAUNCHER_BOOST_SOURCE_ROOT='+deps,
    '-DLZMA_LIBRARY='+path.join(sdk,'usr/lib/liblzma.tbd'),'-DLZMA_INCLUDE_DIR=/opt/homebrew/opt/xz/include',
    '-DZLIB_LIBRARY='+path.join(sdk,'usr/lib/libz.tbd'),'-DZLIB_INCLUDE_DIR='+path.join(sdk,'usr/include'),
    '-DUSE_LTO=OFF','-DWERROR=OFF','-DSTRICT_USE=OFF','-DBoost_USE_STATIC_LIBS=ON','-DBUILD_SHARED_LIBS=OFF','-DFETCHCONTENT_FULLY_DISCONNECTED=ON'];
  const overlaySha256=crypto.createHash('sha256').update(fs.readFileSync(__filename)).update(fs.readFileSync(path.join(NATIVE,'inno-inspect.cpp'))).update(fs.readFileSync(path.join(NATIVE,'static-dependencies.cmake'))).digest('hex');
  const logPath=path.join(directory,'build.log');fs.writeFileSync(logPath,JSON.stringify({version:VERSION,sourceRevision:REVISION,dependencies:DEPENDENCIES,sourceTrees,overlaySha256,options},null,2)+'\n');
  const cmake=Pinned.findBuildTool('cmake'),env={...process.env,MACOSX_DEPLOYMENT_TARGET:'13.0',HOMEBREW_NO_AUTO_UPDATE:'1'};
  logger.info?.('Building the pinned static installer helper');
  await Pinned.runBuildCommand(cmake,['-S',upstream,'-B',output,'-G','Ninja',...options],{cwd:directory,env,logPath,signal});
  await Pinned.runBuildCommand(cmake,['--build',output,'--parallel','6'],{cwd:directory,env,logPath,signal});
  await Pinned.runBuildCommand(cmake,['--install',output],{cwd:directory,env,logPath,signal});
  await Promise.all(Object.entries(pins).map(([name,revision])=>Pinned.validatePinnedSource(dirs[name],revision,{signal})));
  return {version:VERSION,sourceRevision:REVISION,dependencyPins:DEPENDENCIES,sourceTrees,overlaySha256,configureOptions:options,logPath,payload,
    executables:Object.fromEntries(['innoextract','maclauncher-inno-inspect'].map(name=>[name,{path:path.join(payload,'bin',name),sha256:hash(path.join(payload,'bin',name))}]))};
}
module.exports={VERSION,REVISION,BOOST_VERSION,DEPENDENCIES,adaptSource,buildCandidate};
