'use strict';
const fs=require('node:fs'),path=require('node:path');
const {inspectBinary}=require('../core/binary-arch');
const {validateDeclared,validateBuild}=require('./schema');

// The installer supplies its executable inventory after extraction and signature
// verification. The returned record is persisted with that immutable install.
function measureBuild({source,root,files,declares,id,version,provenance={},parent,parts,intendedCPU}={}) {
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
 validateDeclared(intendedCPU,binaries);
 return validateBuild({id,sourceId:source.id,source:source.id,kind:source.kind,version,installed:true,measured:true,root:base,binaries,...(parts?{parts:structuredClone(parts)}:{}),
  ...(parent?{parent}:{}),provenance:structuredClone(provenance)});
}
module.exports={measureBuild};
