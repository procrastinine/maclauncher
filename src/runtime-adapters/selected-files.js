'use strict';
const fs=require('node:fs'),path=require('node:path');
const Writable=require('../modules/shared/writable-input');

// Core has already admitted logical files and selected their destinations.
function apply({build={},parts={},environment={},parameters={}}={}) {
 const root=require('./view-directory').directoryFor(build,parameters.directory||parameters.viewRoot);
 const links={},dllOverrides=[];
 for(const file of parts.files||[]) {
  const relative=file.relative,source=file.path;
  if(!relative||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').some(p=>p==='..'||p==='.')||relative.includes('\0'))throw new Error('A component view link must stay inside its view.');
  if(!path.isAbsolute(source)||!fs.statSync(source).isFile())throw new Error('A selected component part is missing.');
  const target=path.join(root,relative);Writable.assertOwnDirectory(root,path.dirname(target));
  const current=fs.lstatSync(target,{throwIfNoEntry:false});
  if(current) {
   if(!current.isSymbolicLink()||fs.realpathSync(target)!==fs.realpathSync(source))throw new Error('A prepared component view is immutable.');
  } else {
   fs.mkdirSync(path.dirname(target),{recursive:true});
   fs.symlinkSync(source,target);
  }
  links[relative]=target;
  if(file.dllOverride)dllOverrides.push(file.dllOverride);
 }
 const host=(parts.files||[]).filter(file=>file.format==='macho');
 return {root,environment:{...environment},links,dllOverrides:[...new Set(dllOverrides)],
  libraryPaths:[...new Set(host.map(file=>path.dirname(file.path)))],
  frameworkPaths:[...new Set(host.flatMap(file=>{const index=file.path.indexOf('.framework/');return index<0?[]:[path.dirname(file.path.slice(0,index+10))];}))]};
}
module.exports={apply};
