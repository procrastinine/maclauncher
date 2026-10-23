import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),B=require('../src/modules/shared/runtime/bundled-native'),S=require('./native-supplementals.cjs'),Json=require('../src/core/json-files');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sourceArchive=name=>/(?:^|\/)source\.tar\.(?:gz|bz2|xz)$/.test(name);

/** Publish a fresh graphics package while retaining the original sealed input. */
export function repackageGraphics({declarationFile,resourceRoot,replacements={},revision='portable1',sourceIdentity}){
 const declarations=JSON.parse(fs.readFileSync(declarationFile));
 if(!Array.isArray(declarations)||declarations.length!==1||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(revision))throw Error('Select one graphics package and a package revision.');
 if(sourceIdentity&&(!/^[a-f0-9]{64}$/.test(sourceIdentity.sha256||'')||!Array.isArray(sourceIdentity.pins)||sourceIdentity.pins.some(pin=>typeof pin!=='string'||!/^[a-f0-9]{40} third_party\/[A-Za-z0-9._/-]+$/.test(pin))))throw Error('Select an exact graphics source identity and source pins.');
 const previous=S.validateDeclaration(declarations[0]),input=path.join(resourceRoot,previous.directoryRelative);
 B.verifyPayload(input,previous);const version=previous.version+'-'+revision,directoryRelative=previous.id+'/'+version+'/'+previous.arch,destination=path.join(resourceRoot,directoryRelative);
 if(fs.existsSync(destination))throw Error('The graphics package revision already exists.');
 const selected=previous.files.filter(f=>!sourceArchive(f.path));
 for(const relative of Object.keys(replacements))if(!selected.some(f=>f.path===relative)||relative===previous.manifestRelative)throw Error('Replacement is outside the selected runtime inventory.');
 const temporary=fs.mkdtempSync(path.join(resourceRoot,'.graphics-publication-'));
 try{
  for(const row of selected){const target=path.join(temporary,row.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(replacements[row.path]||path.join(input,row.path),target,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);fs.chmodSync(target,row.mode);}
  // Optional providers retain their own exact inventory after a native file changes.
  for(const row of selected.filter(f=>f.path.endsWith('/provider.json'))){const file=path.join(temporary,row.path),descriptor=JSON.parse(fs.readFileSync(file));if(!Array.isArray(descriptor.files))continue;for(const entry of descriptor.files){B.relativeFile(entry.path);let member=path.join(path.dirname(file),entry.path);if(!fs.existsSync(member))member=path.join(temporary,entry.path);if(!fs.existsSync(member))throw Error('Optional graphics provider inventory is incomplete: '+entry.path);entry.size=fs.statSync(member).size;entry.sha256=digest(fs.readFileSync(member));}fs.writeFileSync(file,JSON.stringify(descriptor,null,2)+'\n');}
  const manifestFile=path.join(temporary,previous.manifestRelative),manifest=JSON.parse(fs.readFileSync(manifestFile));manifest.version=version;
  if(sourceIdentity){manifest.sourceHash=sourceIdentity.sha256;manifest.sourcePins=sourceIdentity.pins;}
  const prefix=manifest.schemaVersion===1&&manifest.managerId?'files/':'';
  manifest.files=manifest.files.filter(f=>!sourceArchive(f.path)).map(row=>{const file=path.join(temporary,prefix+row.path),stat=fs.statSync(file);return {...row,size:stat.size,mode:stat.mode&0o777,sha256:digest(fs.readFileSync(file))};});
  fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
  const files=selected.map(row=>{const file=path.join(temporary,row.path),stat=fs.statSync(file);return {...row,size:stat.size,mode:stat.mode&0o777,sha256:digest(fs.readFileSync(file))};});
  const manifestSha256=files.find(f=>f.path===previous.manifestRelative).sha256;
  const {sourceArtifact:oldSourceArtifact,...base}=previous;
  const declaration=S.validateDeclaration({...base,version,directoryRelative,sourceRelative:null,sourceSha256:sourceIdentity?.sha256||previous.sourceSha256,manifestSha256,files});
  B.verifyPayload(temporary,declaration);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.renameSync(temporary,destination);
  Json.writeJsonAtomic(declarationFile,[declaration]);return {destination,declaration};
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const options={replacements:{}};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];if(!value)throw Error('Use explicit --option value pairs.');if(key==='--replace'){const split=value.indexOf('=');if(split<1)throw Error('Replacement syntax is relative/path=/absolute/file.');options.replacements[value.slice(0,split)]=value.slice(split+1);}else if(key==='--declaration')options.declarationFile=value;else if(key==='--resources')options.resourceRoot=value;else if(key==='--revision')options.revision=value;else throw Error('Unknown graphics package option.');}
 console.log(JSON.stringify(repackageGraphics(options)));
}
