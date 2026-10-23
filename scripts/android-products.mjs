import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {productInventory} from '../src/modules/android/native/build-sources.mjs';
import Staging from './stage-native-runtimes.cjs';
import Supplemental from './native-supplementals.cjs';
import JsonFiles from '../src/core/json-files.js';
import {isDeepStrictEqual} from 'node:util';

/** Register a verified JVM or ART package while retaining the replaced package's
 * exact offline identity. Payload storage and release inclusion are separate. */
export function publishAndroidDeclaration(declaration,{moduleRoot=path.resolve(import.meta.dirname,'../src/modules/android')}={}){
  if(!['android','android-art'].includes(declaration?.id))throw Error('Android declaration publication requires a JVM or ART package.');
  Supplemental.validateDeclaration(declaration);
  const catalogFile=path.join(moduleRoot,'distribution-supplementals.json');
  let catalog=[];
  try{catalog=JSON.parse(fs.readFileSync(catalogFile,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(!Array.isArray(catalog))throw Error('Android runtime declarations are invalid.');
  const replaced=catalog.filter(item=>item.id===declaration.id&&item.arch===declaration.arch);
  for(const previous of replaced){
    Supplemental.validateDeclaration(previous);
    if(previous.version===declaration.version&&!isDeepStrictEqual(previous,declaration))
      throw Error('Android runtime version is already declared with different metadata.');
  }
  const retired=replaced.filter(item=>item.version!==declaration.version);
  const retainedFile=path.join(moduleRoot,...(declaration.id==='android-art'?['art']:[]),'retained-versions.json');
  if(retired.length){
    let retained={schemaVersion:1,packages:[]};
    try{retained=JSON.parse(fs.readFileSync(retainedFile,'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(retained?.schemaVersion!==1||!Array.isArray(retained.packages)||retained.packages.some(item=>
      item?.id!==declaration.id||typeof item.version!=='string'||
      item.directoryRelative!==`${item.id}/${item.version}/${item.arch}`))
      throw Error('Retained Android runtime declarations are invalid.');
    const packages=retained.packages.slice();
    for(const previous of retired){
      const index=packages.findIndex(item=>item.directoryRelative===previous.directoryRelative);
      if(index<0)packages.push(previous);
      else{
        const stored=packages[index];
        if(['manifestRelative','manifestSha256','sourceRelative','sourceSha256'].some(key=>stored[key]!==previous[key])||
          stored.files&&!isDeepStrictEqual(stored,previous))
          throw Error('Retained Android runtime version has a different package identity.');
        packages[index]=previous;
      }
    }
    // Retention commits first: failure to activate a new package cannot remove
    // the previous default or its existing exact version selection.
    if(!isDeepStrictEqual(packages,retained.packages))JsonFiles.writeJsonAtomic(retainedFile,{...retained,packages});
  }
  const next=[declaration,...catalog.filter(item=>item.id!==declaration.id||item.arch!==declaration.arch)];
  if(!isDeepStrictEqual(next,catalog))JsonFiles.writeJsonAtomic(catalogFile,next);
  return {catalogFile,retainedFile,retainedVersions:retired.map(item=>item.version)};
}

/** Remove developer debug records from the copied ANGLE delivery only. Verify
 * the completed build bytes before transforming them; final staging inventories
 * the signed result. The supplied Android framework library stays byte-exact. */
export function publishAndroidAngle(payload,products,angle){
  const files=(angle||[]).map(entry=>{
    if(typeof entry.path!=='string'||path.basename(entry.path)!==entry.path||!entry.path.endsWith('.dylib'))
      throw Error('Invalid Android ANGLE product path');
    const name='native/angle/'+entry.path,product=products.find(value=>value.path===name);
    const file=path.join(payload,name),stat=fs.lstatSync(file),bytes=fs.readFileSync(file);
    const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
    if(!stat.isFile()||!product||product.sha256!==sha256||entry.sha256!==sha256||entry.size!==bytes.length)
      throw Error('Android ANGLE product changed before publication: '+entry.path);
    return file;
  });
  for(const file of files){
    execFileSync('/usr/bin/strip',['-S',file],{stdio:'pipe',timeout:60000});
    execFileSync('/usr/bin/codesign',['--force','--sign','-',file],{stdio:'pipe',timeout:60000});
  }
}

/** Publish informational build notices through the shared provenance boundary.
 * Operational receipts and original cached products remain private and intact. */
export function publishAndroidNotices(payload,pathMappings){
  const root=path.join(payload,'notices');
  if(!fs.existsSync(root))return;
  function visit(directory){
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())visit(file);
      else if(entry.isFile()&&entry.name.endsWith('.json')){
        const original=fs.readFileSync(file,'utf8');
        const parsed=JSON.parse(original),projected=Staging.publicProvenance(parsed,pathMappings);
        if(JSON.stringify(projected)===JSON.stringify(parsed))continue;
        const text=JSON.stringify(projected,null,2)+'\n';
        if(text!==original)fs.writeFileSync(file,text);
      }
    }
  }
  visit(root);
}

/** The compiler output is the payload. There is no second list of libraries,
 * data directories or JARs for staging to accidentally omit. */
export function copyAndroidProducts(build,payload,products) {
  if(!Array.isArray(products)||!products.length)throw Error('Android build has no product inventory');
  const actual=productInventory(build);
  if(JSON.stringify(actual)!==JSON.stringify(products))throw Error('Android build products changed after compilation');
  const byPath=new Map(products.map(product=>[product.path,product]));
  // Upstream resource modules include aliases (for example older font names).
  // Materialize their recorded target bytes in the portable regular-file
  // payload. An alias cannot import a build input or a file outside this closure.
  function targetOf(product,seen=new Set()){
    if(product.link===undefined)return product;
    if(seen.has(product.path))throw Error('Cyclic Android product alias: '+product.path);
    seen.add(product.path);
    if(typeof product.link!=='string'||!product.link||product.link.includes('\\')||path.isAbsolute(product.link))
      throw Error('Nonportable Android product alias: '+product.path);
    const name=path.normalize(path.join(path.dirname(product.path),product.link));
    const target=byPath.get(name);
    if(!target)throw Error('Android product alias target is not a recorded product: '+product.path);
    return targetOf(target,seen);
  }
  for(const product of products){
    const name=product.path;
    if(typeof name!=='string'||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..')||path.isAbsolute(name))throw Error('Invalid Android product path');
    const target=targetOf(product);
    const input=path.join(build,target.path),output=path.join(payload,name),stat=fs.lstatSync(input);
    if(!stat.isFile())throw Error('Android product target is not a regular file: '+name);
    fs.mkdirSync(path.dirname(output),{recursive:true});fs.copyFileSync(input,output,fs.constants.COPYFILE_FICLONE);
    if(crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex')!==target.sha256)throw Error('Android product changed while staging: '+name);
    fs.chmodSync(output,stat.mode&0o111?0o755:0o644);
  }
  return products.length;
}
