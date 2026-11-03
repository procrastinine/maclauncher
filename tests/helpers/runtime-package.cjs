const fs=require('node:fs'),path=require('node:path');
const B=require('../../src/modules/shared/runtime/bundled-native'),Payload=require('../../scripts/native-payload.cjs');
async function packageFor(root,id,{dependencies=[],aliases={},externalFacts=[],manifestRelative='manifest.json',manifestValues={}}={}){
 const bytes=Buffer.from('owned entry '+id),library=Buffer.from('shared library bytes');
 const payload=[{path:'entry.js',bytes},...(id==='shared-stack'?[{path:'lib/shared.dylib',bytes:library}]:[]),{path:'LICENSE',bytes:Buffer.from('retained notice')}];
 const facts=payload.map(file=>({path:file.path,size:file.bytes.length,mode:0o644,sha256:B.digest(file.bytes)}));
 const logical=[...facts,...externalFacts];
 for(const[name,target]of Object.entries(aliases))if(typeof target==='string')logical.push({...facts.find(file=>file.path===target),path:name});
 const manifestBytes=Buffer.from(JSON.stringify({schemaVersion:1,id,version:'1.0.0',kind:'data',minimumMacOS:'13.0',files:logical,...manifestValues}));
 const manifest={path:manifestRelative,size:manifestBytes.length,mode:0o644,sha256:B.digest(manifestBytes)};
 const declaration={id,version:'1.0.0',arch:'universal',launcherArchitectures:['arm64','x64'],minimumMacOS:'13.0',directoryRelative:id+'/1.0.0/universal',
  manifestRelative,manifestSha256:manifest.sha256,sourceRelative:null,sourceSha256:manifest.sha256,files:[...facts,manifest],
  notices:[{name:'retained',license:'MIT',path:'LICENSE'}],...(dependencies.length?{dependencies}:{}),...(Object.keys(aliases).length?{aliases:{schema:1,files:aliases}}:{})};
 const archive=path.join(root,id+'-1.0.0-universal.tar.gz'),outer=Buffer.from(JSON.stringify(declaration,null,2)+'\n');
 await Payload.writeArchive([{name:'runtime-package.json',bytes:outer,size:outer.length,mode:0o644},...payload.map(file=>({name:'files/'+file.path,bytes:file.bytes,size:file.bytes.length,mode:0o644})),{name:'files/'+manifestRelative,bytes:manifestBytes,size:manifestBytes.length,mode:0o644}].map(entry=>({...entry,sha256:B.digest(entry.bytes)})),archive);
 const repository='example/runtime-builds',tag=id+'/v1.0.0/universal',filename=path.basename(archive);
 const record={schemaVersion:2,id,version:'1.0.0',arch:'universal',launcherArchitectures:['arm64','x64'],minimumMacOS:'13.0',manifestRelative,manifestSha256:manifest.sha256,sourceSha256:manifest.sha256,updatePolicy:'manual',tag,
  asset:{filename,bytes:fs.statSync(archive).size,sha256:await Payload.checksum(archive),url:'https://github.com/'+repository+'/releases/download/'+encodeURIComponent(tag)+'/'+filename},...(dependencies.length?{dependencies}:{}),...(dependencies.length||Object.keys(aliases).length?{launcherContract:2}:{}),source:{repository,revision:'a'.repeat(40)}};
 return{record,declaration,archive,facts,outer};
}
module.exports={packageFor};
