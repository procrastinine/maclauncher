const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const C=require('../src/modules/shared/runtime/package-contract.cjs'),B=require('../src/modules/shared/runtime/bundled-native');
function fixture(t){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'package-alias-contract-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function file(root,name,bytes){const target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{mode:0o644});return{path:name,size:Buffer.byteLength(bytes),sha256:B.digest(Buffer.from(bytes)),mode:0o644};}
test('frozen dependencies and aliases reject ambiguous targets, cycles, traversal and file collisions',()=>{
 const dep={project:'shared-stack',release:'1.0.0',sha256:'a'.repeat(64)},files=[{path:'lib/a.dylib'}];
 assert.deepEqual(C.packageDependencies([dep]),[dep]);assert.throws(()=>C.packageDependencies([dep,dep]),/one exact/);
 for(const aliases of [{schema:1,files:{'lib/a.dylib':'lib/a.dylib'}},{schema:1,files:{'../escape':'lib/a.dylib'}},{schema:1,files:{'one':'two','two':'one'}},{schema:1,files:{'lib/alias':{project:'other',path:'lib/a.dylib'}}},{schema:1,files:{lib:'lib/a.dylib'}}])assert.throws(()=>C.packageAliases(aliases,files,[dep]));
});
test('stored archive verification and installed verification keep separate exact inventories',t=>{
 const root=fixture(t),record=file(root,'canonical.jar','exact bytes'),declaration={files:[record],aliases:{schema:1,files:{'logical.jar':'canonical.jar'}}};
 assert.equal(B.verifyStoredPayload(root,declaration),true);assert.throws(()=>B.verifyPayload(root,declaration),/inventory differs/);
 fs.copyFileSync(path.join(root,'canonical.jar'),path.join(root,'logical.jar'));
 assert.equal(B.verifyPayload(root,declaration),true);assert.throws(()=>B.verifyStoredPayload(root,declaration),/inventory differs/);
 fs.writeFileSync(path.join(root,'logical.jar'),'changed');assert.throws(()=>B.verifyPayload(root,declaration),/checksum/);
});
test('dependency aliases require the exact resolved path and sealed target hash, never symlink presence alone',t=>{
 const root=fixture(t),consumer=path.join(root,'consumer'),dependency=path.join(root,'dependency');fs.mkdirSync(consumer);fs.mkdirSync(dependency);
 const stored=file(consumer,'manifest.json','owned manifest'),target=file(dependency,'lib/target.dylib','sealed library');
 const selected={project:'shared-stack',release:'2.0.0',sha256:'a'.repeat(64)},decl={id:'consumer',files:[stored],dependencies:[selected],aliases:{schema:1,files:{'lib/alias.dylib':{project:'shared-stack',path:'lib/target.dylib'}}}};
 const resolve=(alias,dep)=>{assert.deepEqual(dep,selected);assert.equal(alias.path,target.path);return{...target,path:path.join(dependency,target.path)};};
 fs.mkdirSync(path.join(consumer,'lib'));fs.symlinkSync(path.relative(path.join(consumer,'lib'),path.join(dependency,target.path)),path.join(consumer,'lib/alias.dylib'));
 assert.equal(B.verifyPayload(consumer,decl,resolve),true);assert.throws(()=>B.verifyPayload(consumer,decl),/exact installed sealed file/);
 fs.writeFileSync(path.join(dependency,target.path),'broken library');assert.throws(()=>B.verifyPayload(consumer,decl,resolve),/checksum/);
});
