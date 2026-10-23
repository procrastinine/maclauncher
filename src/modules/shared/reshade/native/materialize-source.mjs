import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {copyPinnedReShadeSources} from '../../../../../scripts/stage-reshade-source.mjs';
const root=import.meta.dirname,repository=path.resolve(root,'../../../../..');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

/** Create a complete production CMake source tree from owned files and pinned Git inputs. */
export function materializeSource({output,sources={},baseOnly=false}){
 if(!path.isAbsolute(output||'')||fs.existsSync(output))throw Error('Choose a new absolute graphics source directory.');
 const base=path.join(root,'base'),overlay=JSON.parse(fs.readFileSync(path.join(root,'source-overlay.json')));
 const processor=JSON.parse(fs.readFileSync(path.join(root,'processor-sources.json')));
 const inputs=['CMakeLists.txt','README.md','THIRD_PARTY.md',...['src','compat'].flatMap(dir=>fs.readdirSync(path.join(base,dir),{recursive:true}).map(name=>path.join(dir,name)).filter(name=>fs.statSync(path.join(base,name)).isFile()))].sort();
 if(digest(Buffer.concat(inputs.map(name=>Buffer.concat([Buffer.from(name+'\0'),fs.readFileSync(path.join(base,name))]))))!==overlay.baseSourceHash)throw Error('Graphics base source differs from its declared identity.');
 const directories={};
 for(const entry of processor.sources){
  const directory=path.resolve(sources[entry.id]||path.join(repository,entry.submodulePath));
  const head=execFileSync('git',['-C',directory,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(head!==entry.commit)throw Error('Initialize the selected graphics source commit: '+entry.submodulePath);
  directories[entry.sourcePath]=directory;
 }
 fs.mkdirSync(output,{recursive:true});
 try{
  for(const name of [...inputs,'LICENSE','.gitmodules']){const file=path.join(output,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(path.join(base,name),file);}
  if(!baseOnly)for(const entry of overlay.files){
   const previous=path.join(base,entry.path);
   if(entry.baseSha256?digest(fs.readFileSync(previous))!==entry.baseSha256:fs.existsSync(previous))throw Error('Graphics overlay base differs: '+entry.path);
   const file=path.join(output,entry.path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(path.join(root,entry.source),file);
  }
  copyPinnedReShadeSources('',output,new Set(processor.sources.map(entry=>entry.sourcePath)),directories);
  const libra=JSON.parse(fs.readFileSync(path.join(root,'retroarch-source.json')));
  const libraRoot=path.resolve(sources.librashader||path.join(repository,'src/external/librashader'));
  if(execFileSync('git',['-C',libraRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==libra.commit||
    digest(fs.readFileSync(path.join(libraRoot,'include/librashader.h')))!==libra.headerSha256)throw Error('Initialize the selected librashader source commit.');
  for(const name of ['include/librashader.h','LICENSE.md']){const file=path.join(output,'third_party/librashader',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(path.join(libraRoot,name),file);}
  return {output,sourceSha256:overlay.baseSourceHash,upstreams:processor.sources.map(({id,commit})=>({id,commit}))};
 }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2),baseOnly=args[1]==='--base-only';
 if(!args[0]||args.length>(baseOnly?2:1))throw Error('Usage: node materialize-source.mjs <new source directory> [--base-only]');
 console.log(JSON.stringify(materializeSource({output:path.resolve(args[0]),baseOnly})));
}
