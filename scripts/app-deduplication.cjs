const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const Content = require('./runtime-content.cjs'), B = require('../src/modules/shared/runtime/bundled-native');
function regular(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > B.LIMITS.fileBytes) throw new Error('Application inputs require bounded regular files.');
  return fs.readFileSync(file);
}
function binaryKind(name, bytes) {
  const magic = bytes.subarray(0, 4).toString('hex');
  if (['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic)) return true;
  if (magic === '7f454c46' || magic === '0061736d' || bytes[0] === 0x4d && bytes[1] === 0x5a) return true;
  if (['504b0304','504b0506','504b0708','377abcaf','fd377a58'].includes(magic) || bytes[0] === 0x1f && bytes[1] === 0x8b ||
      bytes.subarray(0, 8).toString('ascii') === '!<arch>\n') return true;
  if (/\.(?:jar|class|dex|odex|vdex|art|dll|dylib|so|node|exe|wasm|luac|pyc|pyo|rpyc|rpyb|zip|tar|tgz|gz|xz|7z)$/i.test(name)) return true;
  return bytes.subarray(0, 4).toString('ascii') === '\x1bLua' || bytes.subarray(0, 3).toString('ascii') === '\x1bLJ';
}
function candidate(name, bytes) {
  const magic=bytes.subarray(0,4).toString('hex');
  if(['feedface','cefaedfe','feedfacf','cffaedfe'].includes(magic))return false;
  if(['cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic)){try{require('../src/modules/shared/runtime/macho-load-commands').parseMachOLoadCommands(bytes);return false;}catch{}}
  if (/(?:^|\/)(?:licenses?|notices?|flash)(?:\/|$)|(?:^|\/)(?:license|notice|copying|copyright|authors)(?:[._-]|$)/i.test(name) ||
      /\.(?:png|jpe?g|gif|webp|ico|icns|svg|ttf|otf|woff2?|wav|ogg|flac|mp3|mp4|webm)$/i.test(name)) return false;
  if (binaryKind(name, bytes) || /\.(?:bin|metallib|spv|pak|dat)$/i.test(name)) return true;
  if (bytes.includes(0)) return true;
  try { new TextDecoder('utf-8',{fatal:true}).decode(bytes); return false; } catch { return true; }
}
function unpackPatterns({projectDir,packageConfig}) {
  const {getMainFileMatchers,getNodeModuleFileMatcher}=require('app-builder-lib/out/fileMatcher');
  const {doMergeConfigs}=require('app-builder-lib/out/util/config/config');
  const root=path.resolve(projectDir),destination='/application',build=Content.applyBuildPolicy(doMergeConfigs([structuredClone(packageConfig.build)]));
  const info={projectDir:root,buildResourcesDir:'build',config:build,isPrepackedAppAsar:false,debugLogger:{isEnabled:false}};
  const matchers=getMainFileMatchers(root,destination,value=>value,build.mac||{},{info},path.join(root,build.directories.output),false);
  const names=new Set();
  function walk(directory,filter,visit,ancestors=new Set()) {
    const real=fs.realpathSync(directory);
    if(!real.startsWith(root+path.sep)&&real!==root||ancestors.has(real))throw new Error('Application input directories contain an escaping or cyclic alias.');
    ancestors.add(real);
    for(const row of fs.readdirSync(directory,{withFileTypes:true})){
      const file=path.join(directory,row.name),stat=fs.statSync(file,{throwIfNoEntry:false});
      if(!stat){if(!filter(file,fs.lstatSync(file)))continue;throw new Error('Application inputs contain an alias without a target.');}
      if(!filter(file,stat))continue;
      if(stat.isDirectory())walk(file,filter,visit,ancestors);
      else if(stat.isFile())visit(file);
      else throw new Error('Application inputs contain a special file.');
    }
    ancestors.delete(real);
  }
  for(const matcher of matchers){
    if(!path.resolve(matcher.from).startsWith(root+path.sep)&&path.resolve(matcher.from)!==root)throw new Error('Application FileSets require checkout-relative sources.');
    walk(matcher.from,matcher.createFilter(),file=>{
    const name=path.relative(destination,path.join(matcher.to,path.relative(matcher.from,file))).split(path.sep).join('/');
    if(!Content.excludedReason(name)&&candidate(name,regular(file)))names.add(name);
    });
  }
  const modules=path.join(root,'node_modules'),filter=getNodeModuleFileMatcher(root,destination,value=>value,build.mac||{},info).createFilter();
  if(fs.existsSync(modules))for(const row of fs.readdirSync(modules,{withFileTypes:true})){
    if(row.name.startsWith('.'))continue;
    const source=path.join(modules,row.name);if(!fs.statSync(source,{throwIfNoEntry:false})?.isDirectory())continue;
    walk(source,filter,file=>{const name=path.relative(modules,file).split(path.sep).join('/');if(!Content.excludedReason(name)&&candidate(name,regular(file)))names.add('node_modules/**/'+name);});
  }
  return [...names];
}
function inventory(appPath) {
  const root=fs.realpathSync(appPath),items=[];
  function walk(directory){for(const row of fs.readdirSync(directory,{withFileTypes:true})){
    const file=path.join(directory,row.name),stat=fs.lstatSync(file);
    if(stat.isDirectory()){walk(file);continue;}
    if(!stat.isFile())continue;
    const name=path.relative(root,file).split(path.sep).join('/');if(name==='Contents/Resources/app.asar')continue;
    const bytes=fs.readFileSync(file);if(!candidate(name,bytes))continue;
    items.push({name,file,mode:stat.mode&0o777,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  }}walk(root);
  const archive=path.join(root,'Contents/Resources/app.asar');
  if(fs.existsSync(archive)){
    const asar=require('@electron/asar');asar.uncache(archive);
    for(const name of asar.listPackage(archive).map(name=>name.replace(/^\//,''))){
      const item=asar.statFile(archive,name,false);if(item.files||item.link||item.unpacked)continue;
      const bytes=asar.extractFile(archive,name);if(candidate(name,bytes))items.push({name:'app.asar/'+name,packed:true,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
    }
  }
  return items;
}
function groups(items) {
  const grouped=new Map();for(const item of items){const key=item.size+':'+item.sha256;if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(item);}
  return [...grouped.values()].filter(items=>items.length>1);
}
function collapse(appPath) {
  let aliases=0,bytesRemoved=0;
  for(const group of groups(inventory(appPath))){
    if(group.some(item=>item.packed))continue;
    const ignored=item=>item.name.startsWith('Contents/Resources/native-runtimes/');
    const required=group.reduce((bits,item)=>bits|(item.mode&0o111),0);
    const candidates=group.filter(item=>(item.mode&required)===required&&group.every(other=>(other.mode&~0o111)===(item.mode&~0o111)));
    if(!candidates.length||group.some(ignored)&&!candidates.some(ignored))continue;
    group.sort((a,b)=>Number(candidates.includes(b))-Number(candidates.includes(a))||Number(ignored(b))-Number(ignored(a))||a.name.localeCompare(b.name));
    const [canonical,...others]=group;
    for(const item of others){
      const temporary=item.file+'.dedupe-'+crypto.randomUUID();
      try{fs.symlinkSync(path.relative(path.dirname(item.file),canonical.file),temporary);fs.renameSync(temporary,item.file);}
      finally{fs.rmSync(temporary,{force:true});}
      aliases++;bytesRemoved+=item.size;
    }
  }
  return {aliases,bytesRemoved};
}
module.exports={candidate,unpackPatterns,collapse};
