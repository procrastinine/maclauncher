const fs=require('node:fs'),path=require('node:path');
const B=require('./bundled-native'),C=require('./package-contract.cjs'),P=require('./package-dependencies');
function read(file){return JSON.parse(B.readRegular(file,B.LIMITS.manifestBytes).bytes);}
function context(resourcesRoot,{lock,verification='full'}={}){
 const native=path.join(resourcesRoot,'native-runtimes');
 lock ||= read(path.join(resourcesRoot,'runtime-packages.json'));
 const installed=new Map(),active=new Set();
 function build(record){
  const key=record.asset.sha256;if(active.has(key))throw new Error('Cyclic included package dependencies.');
  if(installed.has(key))return installed.get(key);active.add(key);
  const declaration=read(path.join(native,'.declarations',key+'.json'));P.assertDeclaration(declaration,record);
  const children=new Map();for(const dependency of C.packageDependencies(record.dependencies)){
   const selected=lock.packages.find(item=>item.id===dependency.project&&item.version===dependency.release&&item.asset.sha256===dependency.sha256);
   if(!selected)throw new Error('Included dependency is absent from the exact application lock.');
   children.set(dependency.project,build(selected));
  }
  const root=path.join(native,B.relativeFile(declaration.directoryRelative)),resolve=P.resolver(children);
  const item=P.attach({record,declaration,root,directory:root,children},{resolveDependency:resolve});installed.set(key,item);active.delete(key);return item;
 }
 function visit(record){
  const item=build(record);if(verification==='full'&&!item.verified){B.verifyPayload(item.root,item.declaration,item.resolveDependency);for(const value of [item,...P.packageFacts(item.children)])installed.get(value.record.asset.sha256).verified=true;}return item;
 }
 function resolveDependencies(dependencies){
  const children=new Map();for(const dep of C.packageDependencies(dependencies)){
   const record=lock.packages.find(item=>item.id===dep.project&&item.version===dep.release&&item.asset.sha256===dep.sha256);
   if(!record)throw new Error('Included dependency release or digest differs from the application lock.');children.set(dep.project,build(record));
  }
  return{installed:children,resolveDependency:P.resolver(children)};
 }
 return{lock,visit,resolveDependencies};
}
module.exports={context};
