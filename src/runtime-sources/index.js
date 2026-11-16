'use strict';
const fs=require('node:fs'),path=require('node:path');
const {KINDS}=require('../core/component-kinds');
const {validateSource}=require('./schema');

// Source declarations are ordinary packaged JSON. Loading them never discovers
// releases, examines local applications or contacts a publisher.
function loadSources(root=__dirname) {
 const sources=[];
 for(const kind of Object.keys(KINDS)) {
  const directory=path.join(root,kind);
  let names;
  try{names=fs.readdirSync(directory);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  for(const name of names.filter(name=>name.endsWith('.json')).sort()) {
   const source=validateSource(JSON.parse(fs.readFileSync(path.join(directory,name),'utf8')));
   if(source.kind!==kind||source.id!==name.slice(0,-5))throw new TypeError(`Runtime source ${kind}/${name} does not match its declared kind and id.`);
   sources.push(source);
  }
 }
 const labels=new Set();for(const source of sources){const key=source.kind+':'+source.label;if(labels.has(key))throw new TypeError('Runtime source labels must be unique within a kind.');labels.add(key);}
 return sources;
}
module.exports={loadSources};
