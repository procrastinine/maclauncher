const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
test('Bionic app namespace finds late companion libraries within the current mounted code directory',async t=>{
 const {ANDROID_NATIVE_SOURCE:native,ANDROID_ART_PAYLOAD:payload,ANDROID_CLANG:clang,ANDROID_JDK:jdk,ANDROID_BIONIC_LINKER:linker}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![native,payload,clang,jdk,linker].every(Boolean))return t.skip('Requires the matched Bionic source, linker, Android compiler, JDK and image supplier');
 const retained=process.env.ANDROID_BIONIC_TEST_OUTPUT,root=fs.mkdtempSync(path.join(retained?path.resolve(retained):os.tmpdir(),'android-library-namespace-'));
 if(!retained)t.after(()=>{
  // The original execution cache seals generated directories. Restore only
  // this fresh test's directory permissions, never shared input-file modes.
  const writable=directory=>{if(!fs.existsSync(directory))return;const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())return;fs.chmodSync(directory,stat.mode|0o700);for(const name of fs.readdirSync(directory))writable(path.join(directory,name));};
  writable(path.join(root,'cache'));fs.rmSync(root,{recursive:true,force:true});
 });
 const run=(program,args,options={})=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:30000,maxBuffer:2<<20,...options});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 const fixture=path.join(__dirname,'fixtures/android-native/bionic-library-namespace'),bionic=path.join(native,'bionic'),installed=path.join(root,'installed'),nativeParent=path.join(installed,'lib'),own=path.join(nativeParent,'arm64'),peer=path.join(root,'peer'),state=path.join(root,'state');
 for(const p of[own,peer,state])fs.mkdirSync(p,{recursive:true});
 for(const p of[installed,nativeParent,own])fs.chmodSync(p,0o700);
 const flags=['-O2','-fPIC','-Wl,-z,max-page-size=16384'];
 for(const [macro,name,directory,extra]of[['PARENT','parent',own,['-ldl']],['DEPENDENCY','dependency',own,[]],['COMPANION','companion',own,['-L'+own,'-lnamespace-dependency']],['PEER','peer',peer,[]]])
  run(clang,[...flags,'-shared','-DNAMESPACE_'+macro,path.join(fixture,'libraries.c'),...extra,'-Wl,-soname,libnamespace-'+name+'.so','-o',path.join(directory,'libnamespace-'+name+'.so')]);
 const includes=[native,bionic,path.join(jdk,'include'),path.join(jdk,'include/darwin')].map(p=>'-I'+p),object=path.join(root,'runtime-guest.o');
 run(clang,[...flags,...includes,'-ffunction-sections','-fdata-sections','-Dmain=klj_bionic_embedded_main','-Wno-nullability-completeness','-c',path.join(bionic,'runtime-guest.c'),'-o',object]);
 const executable=path.join(root,'control');run(clang,[...flags,path.join(fixture,'control.c'),object,'-Wl,--gc-sections','-ldl','-o',executable]);
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload)),c=supplier.components;
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const properties=path.join(root,'properties');run(c.bootstrap,[c.image,properties]);
 const app='/data/app/org.maclauncher.namespace/lib/arm64',original=process.env.ANDROID_BIONIC_ORIGINAL_LIBRARIES;
 const originalNames=original?fs.readdirSync(original).filter(n=>n.endsWith('.so')):[];
 // Original supplied libraries share only this test's private, read-only code
 // view. No APK or installed preparation is changed by the control.
 for(const name of originalNames)fs.linkSync(path.join(original,name),path.join(own,name));
 const text=layout({supplier,state})+'ro\t/apex/com.android.runtime/bin/linker64\t'+path.resolve(linker)+'\nro\t/dev/__properties__\t'+properties+'\nro\t/data/local/tmp/namespace-control\t'+executable+'\nro\t/data/app/org.maclauncher.namespace\t'+installed+'\nro\t/data/app/org.maclauncher.namespace/lib\t'+nativeParent+'\nro\t'+app+'\t'+own+'\nro\t/data/app/org.maclauncher.peer/lib/arm64\t'+peer+'\n';
 const map=publishPathMap(state,'namespace',prepareMountParents(text,path.join(root,'mounts'))),env={...environment(supplier),...(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment};
 // Match normal bootstrap: original init creates platform namespace links
 // before this app selects its installed-code search directory.
 run(c.linuxRun,['--inherit-env','--path-map',map,'--cache',path.join(root,'cache'),'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});
 const identity='service\torg.maclauncher.namespace\nuid\t10073\ngid\t10073\ncap_effective\t0\ncap_permitted\t0\ncap_bounding\t0\nseclabel\tu:r:untrusted_app:s0\n';
 const args=['--inherit-env','--guest-fds','0,1,2','--identity-text',identity,'--host-module',c.hostLibrary,'--path-map',map,'--cache',path.join(root,'cache'),'/data/local/tmp/namespace-control'];
 const denied=run(c.linuxRun,[...args,'--denied',app],{env});
 assert.match(denied.stdout,/PASS uninitialized host-private installed-code parents deny app traversal/);
 // Initialize only the read-only code directories already in the path map.
 // Existing per-inode declarations and physical host permissions survive.
 const inodeBootstrap=process.env.ANDROID_BIONIC_INODE_BOOTSTRAP||c.bootstrap;
 run(inodeBootstrap,['initialize-package',installed,nativeParent,own]);
 for(const p of[installed,nativeParent,own])assert.equal(fs.statSync(p).mode&0o777,0o700);
 const extra=original?['libflutter_soloud_plugin.so','initEngine']:[];
 const result=run(c.linuxRun,[...args,app,...extra],{env});
 fs.writeFileSync(path.join(root,'stdout.log'),result.stdout);fs.writeFileSync(path.join(root,'stderr.log'),result.stderr);
 assert.match(result.stdout,/PASS original Bionic caller namespace sibling dependency and peer exclusion/);
 if(original)assert.match(result.stdout,/PASS original APK companion loads through original caller namespace/);
 t.diagnostic('Evidence '+root);
});
