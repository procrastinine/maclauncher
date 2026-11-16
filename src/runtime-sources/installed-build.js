'use strict';
const fs=require('node:fs'),path=require('node:path');
const {inspectBinary}=require('../core/binary-arch');
const {validateSource,validateDeclared,validateBuild}=require('./schema');

// The installer supplies its executable inventory after extraction and signature
// verification. The returned record is persisted with that immutable install.
function measureBuild({source,root,files,declares,id,version,provenance={},parent}={}) {
 validateSource(source);
 const base=fs.realpathSync(root);
 if(!Array.isArray(files)||!files.length)throw new TypeError('An installed executable inventory is required.');
 const seen=new Set();
 const binaries=files.map(file=>{
  if(typeof file!=='string'||path.isAbsolute(file)||file.includes('\\')||file.split('/').includes('..')||file.includes('\0'))throw new TypeError('Installed binary paths must be relative.');
  if(seen.has(file))throw new TypeError('Installed binary paths must be unique.');seen.add(file);
  const absolute=fs.realpathSync(path.join(base,file));
  if(!absolute.startsWith(base+path.sep))throw new Error('An installed executable is outside its payload.');
  return {path:file,...inspectBinary(absolute)};
 });
 validateDeclared(declares,binaries);
 return validateBuild({id,source:source.id,kind:source.kind,version,installed:true,binaries,
  interfaces:structuredClone(source.interfaces||{provides:[],requires:[]}),
  ...(source.reach?{reach:structuredClone(source.reach)}:{}),
  ...(parent?{parent}:{}),provenance:structuredClone(provenance)});
}
module.exports={measureBuild};
