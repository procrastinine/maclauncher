const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
function candidate(name, bytes) {
  const magic=bytes.subarray(0,4).toString('hex');
  if(['feedface','cefaedfe','feedfacf','cffaedfe'].includes(magic))return false;
  if(['cafebabe','bebafeca','cafebabf','bfbafeca'].includes(magic)){try{require('../src/modules/shared/runtime/macho-load-commands').parseMachOLoadCommands(bytes);return false;}catch{}}
  if (/(?:^|\/)(?:licenses?|notices?|flash)(?:\/|$)|(?:^|\/)(?:license|notice|copying|copyright|authors)(?:[._-]|$)/i.test(name) ||
      /\.(?:png|jpe?g|gif|webp|ico|icns|svg|ttf|otf|woff2?|wav|ogg|flac|mp3|mp4|webm)$/i.test(name)) return false;
  if (require('./app-inputs.cjs').binaryKind(name, bytes) || /\.(?:bin|metallib|spv|pak|dat)$/i.test(name)) return true;
  if (bytes.includes(0)) return true;
  try { new TextDecoder('utf-8',{fatal:true}).decode(bytes); return false; } catch { return true; }
}
function unpackPatterns(selected) {
  const names=[];
  for (const [name,record] of selected.asar) if(candidate(name,fs.readFileSync(record.source))) names.push(name);
  for (const supplier of selected.suppliers.values()) for (const [name,record] of supplier.files)
    if(candidate(name,fs.readFileSync(record.source))) names.push('node_modules/**/'+supplier.name+'/'+name);
  return names;
}
function inventory(appPath) {
  const root=fs.realpathSync(appPath),items=[];
  for(const name of require('./check-packaging.cjs').appTree(root).files){
    const file=path.join(root,name),stat=fs.lstatSync(file);
    if(!stat.isFile() || name==='Contents/Resources/app.asar')continue;
    const bytes=fs.readFileSync(file);if(!candidate(name,bytes))continue;
    items.push({name,file,mode:stat.mode&0o777,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  }
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
    if(group.some(item=>item.packed))throw new Error('Duplicate binary must use the shared ASAR unpack selection: '+group.map(item=>item.name).join(', '));
    const ignored=item=>item.name.startsWith('Contents/Resources/native-runtimes/');
    const required=group.reduce((bits,item)=>bits|(item.mode&0o111),0);
    const candidates=group.filter(item=>(item.mode&required)===required&&group.every(other=>(other.mode&~0o111)===(item.mode&~0o111)));
    if(!candidates.length||group.some(ignored)&&!candidates.some(ignored))throw new Error('Duplicate data has incompatible permissions across the native-runtimes signing boundary.');
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
function assertUnique(appPath) {
  const duplicates=groups(inventory(appPath));
  if(duplicates.length)throw new Error('Application stores duplicate binary bytes:\n'+duplicates.map(group=>group.map(item=>item.name).join(' = ')).join('\n'));
  return true;
}
module.exports={candidate,unpackPatterns,collapse,assertUnique};
