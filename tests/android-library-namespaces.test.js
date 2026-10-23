const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
test('shared native namespaces preserve original Bionic access and loader ownership',async t=>{
 const bionic=process.env.ANDROID_BIONIC_SOURCE,art=process.env.ANDROID_ART_SOURCE;
 if(!bionic||!art){t.skip('Set ANDROID_BIONIC_SOURCE and ANDROID_ART_SOURCE to the pinned source repositories');return;}
 const root=path.resolve(__dirname,'../src/modules/android/native'),work=fs.mkdtempSync(path.join(os.tmpdir(),'android-namespaces-'));
 t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const {prepareLibraryNamespaces}=await import('../src/modules/android/native/library-namespace-source.mjs');
 const generated=prepareLibraryNamespaces({bionicSource:bionic,artSource:art,output:path.join(work,'source')});
 const files=path.join(work,'files');
 for(const name of ['ld/same.so','default/same.so','run/run.so','permit/nested/deep.so','outside/allowed.so','outside/hidden.so']){
  const file=path.join(files,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'');
 }
 fs.symlinkSync(path.join(files,'outside/hidden.so'),path.join(files,'ld/escape.so'));
 for(const [name,elfClass] of [['app/dep32.so',1],['app/dep64.so',2],['app/lib/run.so',1],['app/lib64/run.so',2]]){
  const file=path.join(files,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.from([0x7f,0x45,0x4c,0x46,elfClass]));
 }
 fs.writeFileSync(path.join(files,'app/translated.so'),Buffer.from([0xcf,0xfa,0xed,0xfe]));
 const binary=path.join(work,'probe');
 execFileSync('clang++',['-std=c++20','-Wall','-Wextra','-Werror','-I'+root,'-I'+generated.include,path.join(root,'library-namespace.cpp'),path.join(__dirname,'fixtures/android-library-namespaces/namespace.cpp'),'-o',binary]);
 assert.match(execFileSync(binary,[fs.realpathSync(files)],{encoding:'utf8'}),/PASS original Bionic access/);
});
test('both VM bindings use one image load and publication transaction',t=>{
 const root=path.resolve(__dirname,'../src/modules/android/native'),work=fs.mkdtempSync(path.join(os.tmpdir(),'android-image-registry-'));
 t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
 const image=path.join(work,'image.so'),alias=path.join(work,'alias.so');fs.writeFileSync(image,'fixture');fs.symlinkSync(image,alias);
 const binary=path.join(work,'registry');
 execFileSync('clang',['-std=c11','-Wall','-Wextra','-Wno-unused-function','-Werror','-I'+root,path.join(root,'library-registry.c'),path.join(__dirname,'fixtures/android-library-namespaces/registry.c'),'-o',binary]);
 assert.match(execFileSync(binary,[image,alias],{encoding:'utf8'}),/PASS shared image publication/);
});
