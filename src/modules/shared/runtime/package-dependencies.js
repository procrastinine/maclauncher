const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const B=require('./bundled-native'),C=require('./package-contract.cjs'),Catalog=require('./maclauncher-builds');
const {acquireFileLock}=require('../file-lock');
const {cloneOnlySync}=require('../copy-file');
const rootFor=userDataDir=>path.join(userDataDir,'runtimes','.dependencies');
function directory(userDataDir,dep){C.packageDependencies([dep]);return path.join(rootFor(userDataDir),dep.project,dep.release,dep.sha256);}
function same(left,right){return JSON.stringify(C.packageDependencies(left))===JSON.stringify(C.packageDependencies(right));}
function read(file){return JSON.parse(B.readRegular(file,B.LIMITS.manifestBytes).bytes);}
function packageFacts(installed,rows=new Map()){
 for(const item of installed.values()){
  const key=item.record.asset.sha256;
  if(rows.has(key))continue;
  packageFacts(item.children||new Map(),rows);
  rows.set(key,{record:item.record,declaration:item.declaration,root:item.root});
 }
 return [...rows.values()];
}
function resolverFromFacts(packages){
 return(target,dep)=>{
  const selected=packages.find(item=>item.record.id===dep.project&&item.record.version===dep.release&&item.record.asset.sha256===dep.sha256);
  if(!selected||target.project!==dep.project)throw new Error('The installed dependency does not match its exact sealed release.');
  const fact=selected.declaration.files.find(file=>file.path===target.path);
  if(!fact)throw new Error('Dependency alias target is not a canonical stored file.');
  return {...fact,path:path.join(selected.root,fact.path)};
 };
}
function resolver(installed){
 const packages=packageFacts(installed),resolve=resolverFromFacts(packages);
 resolve.packages=packages;
 resolve.verify=()=>{for(const item of packages)B.verifyPayload(item.root,item.declaration,resolverFromFacts(packages));};
 return resolve;
}
function attach(selected,context){
 for(const key of ['dependencyLibraryPaths','dependencyReadRoots'])if(context[key]!==undefined)selected[key]=context[key];
 // The sealed declaration stays with the in-process row and out of serialized runtime state.
 if(context.sealedDeclaration!==undefined)Object.defineProperty(selected,'sealedDeclaration',{value:context.sealedDeclaration,enumerable:false,configurable:true,writable:true});
 if(selected.declaration)B.rememberDependencies(selected.declaration,context.resolveDependency);
 if(selected.item)B.rememberDependencies(selected.item,context.resolveDependency);
 Object.defineProperty(selected,'resolveDependency',{value:context.resolveDependency,enumerable:false,configurable:true,writable:true});
 return selected;
}
function userDataForPayload(root){
 let at=path.resolve(root);
 for(let depth=0;depth<12;depth++,at=path.dirname(at))if(path.basename(at)==='runtimes')return path.dirname(at);
 throw new Error('The dependency package is outside managed runtime storage.');
}
function load(userDataDir,dependencies,{verification='full',seen=new Set()}={}){
 const installed=new Map();
 for(const dep of C.packageDependencies(dependencies)){
  const key=dep.project+'/'+dep.release+'/'+dep.sha256;if(seen.has(key))throw new Error('Cyclic package dependencies.');
  const next=new Set(seen);next.add(key);
  const dir=directory(userDataDir,dep),receipt=read(path.join(dir,'runtime.json'));
  const record=Catalog.validateProjectRecord(receipt.catalogEntry.projectPackage,{projectId:dep.project,repository:receipt.repository});
  if(record.version!==dep.release||record.asset.sha256!==dep.sha256)throw new Error('Dependency receipt differs from its exact release.');
  const declaration=read(path.join(dir,'runtime-package.json'));
  assertDeclaration(declaration,record);
  const children=load(userDataDir,declaration.dependencies,{verification,seen:next}),resolve=resolver(children),root=path.join(dir,'files');
  if(verification==='full')B.verifyPayload(root,declaration,resolve);
  installed.set(dep.project,{record,declaration,root,resolveDependency:resolve,directory:dir,children});
 }
 return installed;
}
function assertDeclaration(declaration,record){
 if(['id','version','arch','minimumMacOS','manifestRelative','manifestSha256','sourceSha256'].some(key=>declaration[key]!==record[key])||
   JSON.stringify(declaration.launcherArchitectures)!==JSON.stringify(record.launcherArchitectures)||!same(declaration.dependencies,record.dependencies)||
   !Array.isArray(declaration.files)||!declaration.files.length)throw new Error('Dependency declaration differs from its selected catalog record.');
 C.packageAliases(declaration.aliases,declaration.files,declaration.dependencies);
 if(declaration.files.find(file=>file.path===record.manifestRelative)?.sha256!==record.manifestSha256)
  throw new Error('The selected dependency manifest is absent from its sealed inventory.');
}
function materialize(root,declaration,resolveDependency,{copy,verify=true}={}){
 C.packageAliases(declaration.aliases,declaration.files,declaration.dependencies);
 const stored=new Map(declaration.files.map(file=>[file.path,file]));
 for(const[name,target]of Object.entries(declaration.aliases?.files||{})){
  const output=path.join(root,name);B.realDirectory(path.dirname(output),{create:true});
  const existing=fs.lstatSync(output,{throwIfNoEntry:false}),nativeAlias=typeof target==='string'&&B.localMachO(stored.get(target));
  if(nativeAlias)B.validateLocalAlias(root,name,target,declaration,resolveDependency);
  const fact=typeof target==='string'?{...stored.get(target),path:path.join(root,target)}:resolveDependency(target,declaration.dependencies.find(dep=>dep.project===target.project));
  if(existing){
   if(typeof target==='string'&&!nativeAlias){
    if(!existing.isFile()||B.readRegular(output,fact.size).sha256!==fact.sha256)throw new Error('An existing local alias differs from its canonical file.');
   }else if(!existing.isSymbolicLink()||fs.readlinkSync(output)!==path.relative(path.dirname(output),fact.path))throw new Error('An existing dependency alias differs from its target.');
   continue;
  }
  const temporary=output+'.alias-'+crypto.randomUUID();
  try{
   if(typeof target==='string'&&!nativeAlias){
    if(copy)copy(fact.path,temporary);
    else try{cloneOnlySync([[fact.path,temporary]]);}catch(error){
     if(!['ENOSYS','ENOTSUP','EOPNOTSUPP','EXDEV','EINVAL'].includes(error.code)&&!/cannot clone|could not clone/.test(error.message))throw error;
     fs.rmSync(temporary,{force:true});fs.copyFileSync(fact.path,temporary,fs.constants.COPYFILE_EXCL);
    }
    fs.chmodSync(temporary,fact.mode);
   }else fs.symlinkSync(path.relative(path.dirname(output),fact.path),temporary);
   fs.renameSync(temporary,output);
  }finally{fs.rmSync(temporary,{force:true});}
 }
 if(verify)B.verifyPayload(root,declaration,resolveDependency);
}
function bind(root,record,logical,resolveDependency,filename,{normalizeFiles=files=>files,message="The runtime archive inventory differs from its sealed manifest."}={}) {
 const declaration=read(filename);assertDeclaration(declaration,record);
 const expanded=normalizeFiles(C.logicalFiles(declaration,resolveDependency)),facts=new Map(expanded.map(file=>[file.path,file]));
 const format=file=>file.format || (file.architectures?'mach-o':null);
 if(logical.files.length!==expanded.length||logical.files.some(file=>{
  const expected=facts.get(file.path);return !expected||expected.sha256!==file.sha256||expected.size!==file.size||
   JSON.stringify(expected.architectures?.slice().sort()||null)!==JSON.stringify(file.architectures?.slice().sort()||null)||format(expected)!==format(file)||(expected.executionArchitecture||null)!==(file.executionArchitecture||null)||
   (expected.mode!==file.mode&&(!Object.hasOwn(declaration.aliases?.files||{},file.path)||(expected.mode&~0o111)!==(file.mode&~0o111)||(expected.mode&file.mode&0o111)!==(file.mode&0o111)));
 }))throw new Error(message);
 return {...logical,files:normalizeFiles(declaration.files),...(declaration.aliases?{aliases:declaration.aliases}:{}),...(declaration.dependencies?{dependencies:declaration.dependencies}:{})};
}
function relocate(root,destination,declaration,resolveDependency){
 for(const[name,target]of Object.entries(declaration.aliases?.files||{})){
  if(typeof target==='string')continue;
  const selected=resolveDependency(target,declaration.dependencies.find(dep=>dep.project===target.project));
  const file=path.join(root,name),temporary=file+'.alias-'+crypto.randomUUID();
  if(!fs.lstatSync(file).isSymbolicLink()||fs.realpathSync(file)!==fs.realpathSync(selected.path))throw new Error('Dependency alias changed before installation commit.');
  try{fs.symlinkSync(path.relative(path.dirname(path.join(destination,name)),selected.path),temporary);fs.renameSync(temporary,file);}
  finally{fs.rmSync(temporary,{force:true});}
 }
}
function relocateInstallation(staging,destination,record,userDataDir){
 if(!record?.dependencies?.length)return;
 const wrapper=path.join(staging,'project-package.json');if(!fs.existsSync(wrapper))return;
 const declaration=read(wrapper),installed=load(userDataDir,declaration.dependencies,{verification:'status'}),resolve=resolver(installed);
 for(const name of ['payload','project-payload'])if(fs.existsSync(path.join(staging,name)))relocate(path.join(staging,name),path.join(destination,name),declaration,resolve);
}
function hash(file){const h=crypto.createHash('sha256'),fd=fs.openSync(file,'r');try{const data=Buffer.alloc(1024*1024);let n;while((n=fs.readSync(fd,data)))h.update(data.subarray(0,n));return h.digest('hex');}finally{fs.closeSync(fd);}}
async function installOne(dep,options,seen){
 const key=dep.project+'/'+dep.release+'/'+dep.sha256;
 if(seen.has(key)||seen.size>128)throw new Error('Cyclic or excessive package dependencies.');
 const next=new Set(seen);next.add(key);
 const target=directory(options.userDataDir,dep);B.realDirectory(path.dirname(target),{create:true});
 if(fs.existsSync(target)){
  try{return load(options.userDataDir,[dep]).get(dep.project);}
  catch{/* Keep the existing package available until its replacement is verified. */}
 }
 const catalog=await(options.fetchCatalog||Catalog.fetchProjectCatalog)({projectId:dep.project,repository:options.repository,signal:options.signal},options.dependencies||{});
 const record=catalog.packages.find(item=>item.version===dep.release&&item.asset.sha256===dep.sha256);
 if(!record)throw new Error('The exact dependency release is not in its public catalog.');
 const children=new Map();for(const child of C.packageDependencies(record.dependencies))children.set(child.project,await installOne(child,options,next));
 const parent=path.dirname(target);B.realDirectory(parent,{create:true});const staging=fs.mkdtempSync(path.join(parent,'.install-'));
 try{
  options.signal?.throwIfAborted();const archive=staging+'.tar.gz',unpacked=staging;
  const download=options.download||((url,file,settings)=>{const U=require('./upstream');return U.download(U.listedFile({...record.asset,url}),file,settings);});
  await download(record.asset.url,archive,{signal:options.signal,onProgress:options.onProgress});
  if(fs.statSync(archive).size!==record.asset.bytes||hash(archive)!==dep.sha256)throw new Error('Dependency archive digest or size differs from its exact release.');
  await(options.extract||require('./project-native-package').extractArchive)(archive,unpacked,options.signal);
  if(JSON.stringify(fs.readdirSync(unpacked).sort())!==JSON.stringify(['files','runtime-package.json']))throw new Error('Invalid dependency archive layout.');
  const declaration=read(path.join(unpacked,'runtime-package.json'));assertDeclaration(declaration,record);
  if(declaration.aliases)B.verifyStoredPayload(path.join(unpacked,'files'),declaration);
  const resolved=resolver(children);materialize(path.join(unpacked,'files'),declaration,resolved,{copy:options.copy});
  fs.writeFileSync(path.join(unpacked,'runtime.json'),JSON.stringify({version:record.version,archiveSha256:dep.sha256,repository:options.repository,catalogEntry:{projectPackage:record}})+'\n',{flag:'wx',mode:0o644});
  options.signal?.throwIfAborted();
  const storage=require('../../../core/storage-maintenance');
  const previous=fs.existsSync(target)?storage.moveToTrash(target):null;
  try{fs.renameSync(unpacked,target);}
  catch(error){
   if(previous)try{fs.renameSync(previous,target);}
   catch(rollbackError){throw new AggregateError([error,rollbackError],`Dependency replacement failed; the previous package remains at ${previous}.`);}
   throw error;
  }
  if(previous)try{await storage.removeTrash(previous);}catch{/* Upkeep resumes guarded trash removal. */}
  return{record,declaration,root:path.join(target,'files'),resolveDependency:resolved,directory:target,children};
 }finally{fs.rmSync(staging,{recursive:true,force:true});fs.rmSync(staging+'.tar.gz',{force:true});}
}
async function prepare(record,options){
 const dependencies=C.packageDependencies(record?.dependencies);
 if(!dependencies.length)return{installed:new Map(),resolveDependency:resolver(new Map()),release:async()=>{}};
 const root=rootFor(options.userDataDir);B.realDirectory(root,{create:true});
 const release=await(options.acquireLock||acquireFileLock)(path.join(root,'.lock'),{signal:options.signal});
 try{const installed=new Map();for(const dep of dependencies)installed.set(dep.project,await installOne(dep,options,new Set()));return{installed,resolveDependency:resolver(installed),release};}
 catch(error){await release();throw error;}
}
function loaderPaths(declaration,installed){
 const aliased=new Set(Object.values(declaration.aliases?.files||{}).filter(value=>value&&typeof value==='object').map(value=>value.project));
 const paths=[];
 for(const[project,item]of installed){
  if(!aliased.has(project))for(const file of item.declaration.files)if(file.format==='mach-o'||file.architectures&&!file.format||/\.(?:dylib|so)$/.test(file.path))paths.push(path.dirname(path.join(item.root,file.path)));
  paths.push(...loaderPaths(item.declaration,loadFromChildren(item)));
 }
 return[...new Set(paths)];
}
function loadFromChildren(item){return item.children||new Map();}
function readRoots(installed){
 return[...new Set([...installed.values()].flatMap(item=>[item.root,...readRoots(item.children||new Map())]))];
}
function contextForPayload(root,userDataDir,{verification='status'}={}){
 const filename=path.join(path.dirname(root),'project-package.json');
 const empty={installed:new Map(),resolveDependency:resolver(new Map()),dependencyLibraryPaths:[],dependencyReadRoots:[]};
 if(!fs.existsSync(filename))return empty;
 const declaration=read(filename);if(!declaration.dependencies?.length)return empty;
 const receipt=read(path.join(path.dirname(root),'runtime.json'));
 assertDeclaration(declaration,receipt.catalogEntry.projectPackage);
 userDataDir ||= userDataForPayload(root);
 const installed=load(userDataDir,declaration.dependencies,{verification});
 return{installed,declaration,record:receipt.catalogEntry.projectPackage,resolveDependency:resolver(installed),dependencyLibraryPaths:loaderPaths(declaration,installed),dependencyReadRoots:readRoots(installed)};
}
function references(userDataDir){
 const roots=[],runtimes=path.join(userDataDir,'runtimes');if(!fs.existsSync(runtimes))return roots;
 for(const project of fs.readdirSync(runtimes,{withFileTypes:true})){
  if(!project.isDirectory()||project.name.startsWith('.'))continue;
  const base=path.join(runtimes,project.name);
  for(const row of fs.readdirSync(base,{withFileTypes:true})){
   if(!row.isDirectory()||row.name.startsWith('.'))continue;
   const candidates=['arm64','x64','universal'].includes(row.name)?fs.readdirSync(path.join(base,row.name),{withFileTypes:true}).filter(x=>x.isDirectory()&&!x.name.startsWith('.')).map(x=>path.join(base,row.name,x.name)): [path.join(base,row.name)];
   for(const directory of candidates){const receipt=path.join(directory,'runtime.json');if(!fs.existsSync(receipt))continue;const record=read(receipt);roots.push(...C.packageDependencies(record.catalogEntry?.projectPackage?.dependencies));}
  }
 }
 return roots;
}
async function collect(userDataDir,{acquireLock=acquireFileLock,removeTrash=require('../../../core/storage-maintenance').removeTrash}={}){
 const store=rootFor(userDataDir);if(!fs.existsSync(store))return;
 const release=await acquireLock(path.join(store,'.lock'),{wait:false});
 if(!release)return {skipped:'busy'};
 try{
  const keep=new Set();function retain(dep){const dir=directory(userDataDir,dep);if(keep.has(dir))return;keep.add(dir);if(fs.existsSync(path.join(dir,'runtime-package.json')))for(const child of C.packageDependencies(read(path.join(dir,'runtime-package.json')).dependencies))retain(child);}
  for(const dep of references(userDataDir))retain(dep);
  for(const project of fs.readdirSync(store,{withFileTypes:true}))if(project.isDirectory()&&!project.name.startsWith('.')){
   const projectRoot=path.join(store,project.name);for(const version of fs.readdirSync(projectRoot,{withFileTypes:true}))if(version.isDirectory()){
    const versionRoot=path.join(projectRoot,version.name);for(const item of fs.readdirSync(versionRoot,{withFileTypes:true}))if((item.isDirectory()||item.isFile())&&(/^[a-f0-9]{64}$/.test(item.name)||/^\.install-[A-Za-z0-9]{6}(?:\.tar\.gz)?$/.test(item.name)||require('../../../core/storage-maintenance').TRASH.test(item.name))){
     const dir=path.join(versionRoot,item.name);if(keep.has(dir))continue;
     if(require('../../../core/storage-maintenance').TRASH.test(item.name)){await removeTrash(dir);continue;}
     if(/^\.install-[A-Za-z0-9]{6}(?:\.tar\.gz)?$/.test(item.name)){await removeTrash(require('../../../core/storage-maintenance').moveToTrash(dir));continue;}
     let receipt;try{receipt=read(path.join(dir,'runtime.json'));}catch{continue;}const dep={project:project.name,release:version.name,sha256:receipt.archiveSha256};
     if(!/^[a-f0-9]{64}$/.test(dep.sha256||'') || item.name!==dep.sha256 || fs.statSync(dir).dev!==fs.statSync(versionRoot).dev)continue;
     if(receipt.archiveSha256!==dep.sha256||receipt.catalogEntry?.projectPackage?.id!==dep.project||receipt.version!==dep.release)continue;
     const trash=require('../../../core/storage-maintenance').moveToTrash(dir);await removeTrash(trash);
    }
   }
  }
 }finally{await release();}
}
module.exports={attach,packageFacts,resolverFromFacts,userDataForPayload,directory,prepare,load,resolver,materialize,loaderPaths,assertDeclaration,bind,relocateInstallation,readRoots,contextForPayload,collect};
