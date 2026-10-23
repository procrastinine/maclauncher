import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const options={};for(let i=2;i<process.argv.length;i+=2)options[process.argv[i].slice(2)]=process.argv[i+1];
for(const key of ['aim-source','archives','rustc','output'])if(!options[key])throw Error('Missing --'+key);
const source=fs.realpathSync(options['aim-source']),rustc=fs.realpathSync(options.rustc),output=path.resolve(options.output),inputs=JSON.parse(fs.readFileSync(options.archives));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(output,{recursive:true});
const search=new Set(inputs.searchDirectories.map(file=>fs.realpathSync(file)));
for(const name of ['libc','serde_json','crc32fast','flate2','sha2']){const input=inputs[name];if(!input||sha(input.path)!==input.sha256)throw Error('Dependency checksum differs: '+name);search.add(path.dirname(input.path));}
const originals=[];
const walk=(directory,relative)=>{for(const name of fs.readdirSync(directory).sort()){const file=path.join(directory,name),entry=path.posix.join(relative,name);if(fs.lstatSync(file).isDirectory())walk(file,entry);else originals.push({path:entry,sha256:sha(file)});}};
for(const directory of ['crates/aim-android-xml/src','tools/android-image-extract/src'])walk(path.join(source,directory),directory);
const compile=(name,file,dependencies=[])=>{
  const target=path.join(output,'lib'+name+'.rlib');
  const args=['--edition=2024','--crate-name',name,'--crate-type','rlib','-C','opt-level=2','-C','debuginfo=0','--remap-path-prefix',path.resolve(import.meta.dirname,'../../../../..')+'=/maclauncher','--remap-path-prefix',source+'=/aim'];
  for(const directory of search)args.push('-L','dependency='+directory);
  for(const name of dependencies)args.push('--extern',name+'='+inputs[name].path);
  execFileSync(rustc,[...args,path.join(source,file),'-o',target],{env:{...process.env,MACOSX_DEPLOYMENT_TARGET:'13.0'},stdio:'inherit'});
  return {path:target,sha256:sha(target)};
};
const result={aim_android_xml:compile('aim_android_xml','crates/aim-android-xml/src/lib.rs'),android_image_extract:compile('android_image_extract','tools/android-image-extract/src/lib.rs',['crc32fast','flate2','sha2']),libc:inputs.libc,serde_json:inputs.serde_json,searchDirectories:[...search],originalSources:originals};
fs.writeFileSync(path.join(output,'dependencies.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({output,originalFiles:originals.length}));
