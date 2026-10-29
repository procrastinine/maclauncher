const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('./helpers/android-java');

test('Demand conversion preserves original APK and dynamic DEX loaders with reusable class bytes',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 const home=process.env.JAVA_HOME||(process.platform==='darwin'?spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim():'');
 if(!runtime||!home||process.platform!=='darwin')return t.skip('Requires Java 21 and KLEPTON_NATIVE_RUNTIME');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-demand-dex-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const env={...process.env};for(const key of Object.keys(env))if(/^(DYLD_|DEX2JVM_|KL_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|CLASSPATH$)/.test(key))delete env[key];
 const run=(tool,args)=>{const result=spawnSync(path.join(home,'bin',tool),args,{encoding:'utf8',env,timeout:30000,maxBuffer:2**20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout+result.stderr;};
 const source=path.resolve(process.env.ANDROID_NATIVE_SOURCE||'src/modules/android/native'),fixtures=path.resolve('tests/fixtures/android-dynamic-dex'),tools=directory+'/runtime';fs.mkdirSync(tools);
 for(const name of ['converter-overlay.jar','dex2jvm.jar','android-api-metadata.jar'])fs.copyFileSync(path.resolve(runtime,name),tools+'/'+name,fs.constants.COPYFILE_FICLONE);
 const converter=[tools+'/converter-overlay.jar',tools+'/dex2jvm.jar'].join(path.delimiter);
 run('javac',['--release','21','-cp',converter,'-d',directory+'/converter',...['ConvertApkSet','DynamicDexConvert','DemandDexConvert'].map(name=>source+'/converter/'+name+'.java')]);
 run('jar',['--update','--file',tools+'/converter-overlay.jar','-C',directory+'/converter','.']);
 const cp=['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name)).join(path.delimiter);
 const publisher=process.env.KLEPTON_AOSP_FRAMEWORK;
 if(!publisher)return t.skip('KLEPTON_AOSP_FRAMEWORK supplies the original loader hierarchy');
 const asm=JSON.parse(fs.readFileSync(source+'/asm-binary.json','utf8')).files.map(file=>source+'/tools/'+file.path).join(path.delimiter);
 run('javac',['--release','21','-cp',asm,'-d',directory+'/adapt',source+'/framework/DexPortability.java',path.resolve('tests/fixtures/android-framework-policy/FrameworkImplementationAudit.java'),fixtures+'/DexLoadersProbe.java']);
 assert.match(run('java',['-cp',directory+'/adapt'+path.delimiter+asm,'DexLoadersProbe',publisher,directory+'/loaders']),/PASS original DEX-loader hierarchy/);
 run('javac',['--release','21','-cp',cp,'-d',directory+'/host',source+'/java/maclauncher/android/HostDigests.java',source+'/java-jvm/maclauncher/android/DynamicDex.java',source+'/java-jvm/maclauncher/android/framework/HostDexFiles.java',source+'/java-jvm/maclauncher/android/bridge/GuestNativeLoader.java',fixtures+'/DemandDexProbe.java',fixtures+'/DelegatingHeadersProbe.java',fixtures+'/MetadataCacheProbe.java']);
 fs.writeFileSync(directory+'/factory.dex',require('./fixtures/android-dynamic-dex/make-factory-dex.cjs')());fs.writeFileSync(directory+'/value.dex',require('./fixtures/android-dynamic-dex/make-dex.cjs')());
 const args=['-Xverify:all','-Dmaclauncher.dex.demand=true','-cp',[directory+'/host',directory+'/loaders',cp].join(path.delimiter),'DemandDexProbe',path.resolve(runtime),tools,directory+'/factory.dex',directory+'/value.dex',directory+'/data'];
 const cold=run('java',args);assert.match(cold,/PASS demand APK \+ dynamic DEX/);assert.match(cold,/activeDemandWorkers=3/);
 const warm=run('java',args);assert.match(warm,/PASS demand APK \+ dynamic DEX/);assert.match(warm,/activeDemandWorkers=0/);
 // Native implementation changes do not enter the conversion identity.
 fs.mkdirSync(tools+'/native');fs.writeFileSync(tools+'/native/implementation','changed native bytes');
 const changedNative=run('java',args);assert.match(changedNative,/activeDemandWorkers=0/);
 // Actual runtime delegation, including caller-held monitors, still supplies
 // verifier hierarchy facts without initializing parent classes.
 for(const [name,superclass]of [['first','HeaderBase'],['second','HeaderMiddle']]){
  const root=directory+'/'+name;fs.mkdirSync(root);
  for(const [type,body]of Object.entries({HeaderBase:'static { System.setProperty("fixture.headers.initialized","yes"); }',HeaderMiddle:'',HeaderLeft:'',HeaderRight:''})){
   const parent=type==='HeaderBase'?'':` extends ${type==='HeaderLeft'?superclass:'HeaderBase'}`;
   fs.writeFileSync(root+'/'+type+'.java',`package fixture.headers; public class ${type}${parent} { ${body} }\n`);
  }
  run('javac',['--release','21','-d',root+'/classes',...['HeaderBase','HeaderMiddle','HeaderLeft','HeaderRight'].map(type=>root+'/'+type+'.java')]);
  run('jar',['--create','--file',directory+'/'+name+'.jar','-C',root+'/classes','.']);
 }
 fs.writeFileSync(directory+'/hierarchy.dex',require('./fixtures/android-dynamic-dex/make-hierarchy-dex.cjs')());
 assert.match(run('java',['-Xverify:all','-Dmaclauncher.dex.demand=true','-cp',directory+'/host'+path.delimiter+cp,'DelegatingHeadersProbe',tools,directory+'/headers-cache',directory+'/hierarchy.dex',directory+'/first.jar',directory+'/second.jar']),/PASS delegated parent headers/);
 // Complete metadata remains available; only facts actually read by conversion
 // belong to that conversion's cache context. No synthetic parent is loadable
 // here, so the upstream converter really reads the metadata fallback resources.
 const metadataProbe=workers=>assert.match(run('java',['-Xverify:all','-Dmaclauncher.dex.demand=true','-cp',directory+'/host'+path.delimiter+cp,'MetadataCacheProbe',tools,directory+'/metadata-cache',directory+'/hierarchy.dex',String(workers)]),/PASS consulted metadata cache/);
 metadataProbe(1);metadataProbe(0);
 const unrelated=directory+'/Unrelated.java';
 fs.writeFileSync(unrelated,'package fixture.headers; public class Unrelated { public void added(double value) {} }\n');
 run('javac',['--release','21','-d',directory+'/unrelated',unrelated]);
 run('jar',['--update','--file',tools+'/android-api-metadata.jar','-C',directory+'/unrelated','.']);
 metadataProbe(0);
 assert.match(run('java',args),/activeDemandWorkers=0/,'unrelated complete metadata additions reuse prepared and dynamic classes');
 fs.writeFileSync(directory+'/index-container-resource','different ZIP container, identical original DEX digest');
 run('jar',['--update','--file',directory+'/data/converted.jar','-C',directory,'index-container-resource']);
 assert.match(run('java',args),/activeDemandWorkers=0/,'index ZIP repacking preserves the verified ordered DEX identity');
 // Absence becoming a supplied fallback must invalidate the old negative fact.
 run('jar',['--update','--file',tools+'/android-api-metadata.jar','-C',directory+'/first/classes','.']);
 metadataProbe(1);metadataProbe(0);
 // This changes HeaderLeft's actual fallback superclass, without changing DEX.
 run('jar',['--update','--file',tools+'/android-api-metadata.jar','-C',directory+'/second/classes','.']);
 metadataProbe(1);metadataProbe(0);
 fs.writeFileSync(directory+'/converter-version','changed converter input');
 run('jar',['--update','--file',tools+'/converter-overlay.jar','-C',directory,'converter-version']);
 metadataProbe(1);
});

test('Only matching runtime profiles enable demand APK preparation',()=>{
 const {argumentsFor}=require('../src/modules/android/conversion'),{runtimeProfile}=require('../src/modules/android/profile');
 const runtime={profile:{nativeLoadTarget:'maclauncher.android.bridge.GuestNativeLoader'},converterClasspath:[{file:'/runtime/converter.jar'}],metadataClasspath:[{file:'/runtime/metadata.jar'}]};
 assert.equal(argumentsFor(runtime,'/output.jar',['/base.apk']).includes('-Dmaclauncher.dex.demand=true'),false);
 runtime.profile.demandDexVersion=1;assert.equal(argumentsFor(runtime,'/output.jar',['/base.apk']).includes('-Dmaclauncher.dex.demand=true'),true);
 assert.equal(runtimeProfile({version:'1',javaMajor:21,frameworkBaseVersion:1,conversionMetadataVersion:1,demandDexVersion:1}).demandDexVersion,1);
});
