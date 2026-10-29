const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('complete original native tables supersede portable entries and preserve exact Mac object bindings',async t=>{
 const home=process.env.JAVA_HOME;if(process.platform!=='darwin'||!home)return t.skip('Requires macOS and Java21');
 const ndk=process.env.ANDROID_NDK_HEADERS;if(!ndk)return t.skip('Requires ANDROID_NDK_HEADERS for the original Android logger ABI');
 const root=path.resolve(__dirname,'../src/modules/android/native'),fixtures=path.resolve(__dirname,'fixtures/android-native');
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'android-registration-owners-'));t.after(()=>fs.rmSync(out,{recursive:true,force:true}));
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 // The registration owner includes the logger ABI the native build derives from the NDK header.
 (await import('../src/modules/android/native/android-log-source.mjs')).prepareAndroidLogAbi({include:ndk,output:out});
 const flags=['-dynamiclib','-std=c11','-Wall','-Wextra','-Werror','-I'+home+'/include','-I'+home+'/include/darwin','-I'+out];
 run('clang',[...flags,fixtures+'/registration-owner-publisher.c','-o',out+'/publisher.dylib']);
 run('clang',[...flags,root+'/framework-native-registration.c',fixtures+'/registration-owner.c','-o',out+'/bridge.dylib']);
 run(home+'/bin/javac',['--release','21','-d',out,fixtures+'/RegistrationOwnerProbe.java']);
 assert.match(run(home+'/bin/java',['-Xcheck:jni','-cp',out,'RegistrationOwnerProbe',out+'/bridge.dylib',out+'/publisher.dylib']),/PASS complete original registration/);
});

test('retained publisher object families register every remaining original native descriptor',async t=>{
 const home=process.env.JAVA_HOME,runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(process.platform!=='darwin'||!home||!runtime)return t.skip('Requires macOS, Java21 and a built framework');
 const root=path.resolve(__dirname,'../src/modules/android/native'),fixtures=path.resolve(__dirname,'fixtures/android-native');
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'android-registration-descriptors-'));t.after(()=>fs.rmSync(out,{recursive:true,force:true}));
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000,maxBuffer:8<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const agent=out+'/capture.dylib',publisher=path.resolve(runtime,'native/libandroid_runtime.dylib');
 run('clang',['-dynamiclib','-std=c11','-Wall','-Wextra','-Werror','-I'+home+'/include','-I'+home+'/include/darwin',fixtures+'/registration-descriptors.c','-o',agent]);
 const cp=[out,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar'),root+'/tools/asm-9.10.1.jar',root+'/tools/asm-tree-9.10.1.jar'].join(path.delimiter);
 run(home+'/bin/javac',['--release','21','-cp',cp,'-d',out,fixtures+'/RegistrationDescriptorsProbe.java',fixtures+'/RegistrationDescriptorsTransform.java',root+'/framework/GraphicsPortability.java']);
 run(home+'/bin/java',['-cp',cp,'RegistrationDescriptorsTransform',path.resolve(runtime,'android-framework.jar'),out]);
 const options=require('../src/modules/android/jvm-options').frameworkJvmOptions;
 assert.match(run(home+'/bin/java',[...options,'-agentpath:'+agent+'='+publisher+'|'+out+'/actual.tsv','-cp',cp,'maclauncher.android.RegistrationDescriptorsProbe',path.resolve(runtime),out+'/data',out+'/expected.tsv',out]),/PASS publisher registration capture/);
 const {frameworkNativeCatalog}=await import('../src/modules/android/native/framework-native-catalog.mjs');
 const catalog=frameworkNativeCatalog(publisher);
 // The original declarations and publisher catalog determine the required
 // families independently of whether the executing VM registered any rows.
 const registered=[...new Set(Object.values(catalog).flat())].map(name=>name.replaceAll('.','/'));
 const family=line=>{const name=line.slice(1,line.indexOf(';'));return registered.some(owner=>name===owner||name.startsWith(owner+'$'));};
 const actual=new Set(fs.readFileSync(out+'/actual.tsv','utf8').trim().split('\n').filter(family));
 // AOSP keeps one Paint declaration for Robolectric only and never registers it on devices.
 const robolectric='Landroid/graphics/Paint;\tnGetRunCharacterAdvance\t(J[CIIIIZI[FILandroid/graphics/RectF;)F';
 const expected=fs.readFileSync(out+'/expected.tsv','utf8').trim().split('\n').filter(family).filter(row=>row!==robolectric);
 const belongs=(row,owner)=>row.startsWith('L'+owner+';')||row.startsWith('L'+owner+'$');
 const owners=registered.filter(owner=>expected.some(row=>belongs(row,owner)));
 assert.ok(owners.length>0,'original declarations require publisher representation families');
 assert.ok(actual.size>0,'actual retained publisher bindings were observed');
 const missingOwners=owners.filter(owner=>![...actual].some(row=>belongs(row,owner)));
 const missing=expected.filter(row=>!actual.has(row));
 assert.deepEqual(missingOwners,[],`Required native representation families did not register; missing descriptors: ${missing.join(', ')}`);
 assert.deepEqual(missing,[],'Retained native object representations require counterparts for every original native descriptor');
 t.diagnostic(`${actual.size} actual runtime JNI descriptors, ${owners.length} representation families`);
});
