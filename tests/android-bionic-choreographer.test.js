const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
test('original Bionic native Choreographer uses the existing Java and detached native Looper owners',{timeout:45000},async t=>{
 const {ANDROID_BIONIC_RUNTIME:runtime,ANDROID_NATIVE_SOURCE:native,ANDROID_JAVA_HOME:java,ANDROID_CLANG:clang,ANDROID_RUNTIME_USER_DATA:profile}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![runtime,native,java,clang,profile].every(Boolean))return t.skip('Requires explicit matched Bionic runtime, native source, Java, Android compiler and existing image profile');
 const output=process.env.ANDROID_CHOREOGRAPHER_OUTPUT?path.resolve(process.env.ANDROID_CHOREOGRAPHER_OUTPUT):fs.mkdtempSync(path.join(os.tmpdir(),'android-bionic-choreographer-'));
 fs.mkdirSync(output,{recursive:true});if(!process.env.ANDROID_CHOREOGRAPHER_OUTPUT)t.after(()=>fs.rmSync(output,{recursive:true,force:true,maxRetries:3}));
 const run=(program,args,options={})=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:30000,maxBuffer:2<<20,...options});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result;};
 const fixture=path.join(__dirname,'fixtures/android-native/bionic-choreographer-original'),bionic=path.join(native,'bionic'),inputs=path.join(output,'input/lib/arm64-v8a'),classes=path.join(output,'classes'),data=path.join(output,'data');
 for(const p of[inputs,classes,path.join(data,'files'),path.join(data,'cache')])fs.mkdirSync(p,{recursive:true});
 const includes=[fixture,native,bionic,path.join(bionic,'choreographer'),path.join(bionic,'choreographer/include'),path.join(bionic,'looper'),path.join(bionic,'ndk'),path.join(bionic,'ndk/include'),path.join(java,'include'),path.join(java,'include/darwin')].map(p=>'-I'+p);
 const helper=path.join(output,'choreographer-control.dylib'),library=path.join(inputs,'libchoreographer-original-control.so');
 const surface=JSON.parse(fs.readFileSync(path.join(bionic,'facades/libandroid.so/exports.json'))).functions;assert.equal(surface.length,431);
 fs.writeFileSync(path.join(output,'libandroid-exports.h'),'static const struct {const char *name,*version;} libandroid_exports[]={\n'+surface.map(p=>'{'+JSON.stringify(p.name)+','+JSON.stringify(p.version)+'}').join(',\n')+'\n};\n');
 run('/usr/bin/clang',['-dynamiclib','-O1','-Wall','-Wextra','-Werror','-Wno-nullability-completeness',...includes,path.join(fixture,'host.c'),'-L'+path.join(runtime,'native'),'-lnativebinding','-lklepton-jvm','-Wl,-rpath,'+path.join(runtime,'native'),'-o',helper]);
 run('/usr/bin/codesign',['--force','--sign','-',helper]);
 // Resolve libandroid's original public API through the process namespace,
 // exactly as an application does; do not link directly to the new carrier.
 run(clang,['-shared','-fPIC','-O2','-Wall','-Wextra','-Werror','-Wno-nullability-completeness','-Wno-deprecated-declarations',...includes,'-I'+output,path.join(fixture,'guest.c'),'-landroid','-Wl,-z,max-page-size=16384','-Wl,-soname,libchoreographer-original-control.so','-o',library]);
 const cp=[classes,path.join(runtime,'android-host.jar'),path.join(runtime,'android-framework.jar')].join(path.delimiter);
 run(path.join(java,'bin/javac'),['--release','21','-cp',cp,'-d',classes,path.join(fixture,'ChoreographerProbe.java')]);
 const manifest=path.join(output,'agent.mf'),agent=path.join(output,'agent.jar');fs.writeFileSync(manifest,'Premain-Class: maclauncher.android.bridge.ChoreographerProbe\n');
 run(path.join(java,'bin/jar'),['cfm',agent,manifest,'-C',classes,'maclauncher/android/bridge/ChoreographerProbe.class']);
 const config={runtimeRoot:runtime,packageName:'org.maclauncher.choreographer',nativeRoot:inputs,resourcesRoot:output,sourceApk:agent,convertedJar:agent,filesRoot:path.join(data,'files'),cacheRoot:path.join(data,'cache')},configFile=path.join(output,'launch.json');fs.writeFileSync(configFile,JSON.stringify(config)+'\n');
 const sandbox=await require('../src/modules/android/sandbox').prepareSandbox({javaPath:path.join(java,'bin/java'),config,configFile,dataRoot:data,userDataDir:profile,processIdentityVersion:1,blockNetwork:true});
 const original=JSON.parse(fs.readFileSync(path.join(runtime,'native/bionic/profile.json'))),state=path.join(data,'cache/bionic'),image=JSON.parse(fs.readFileSync(path.join(state,'bootstrap.json')));
 run(path.join(runtime,original.inodeBootstrap),['initialize','10000',data]);
 const {frameworkJvmOptions}=require('../src/modules/android/jvm-options');
 const args=[...sandbox.prefix,...sandbox.javaArguments,...frameworkJvmOptions,'-XstartOnFirstThread','-Xcheck:jni','-Xmx96m','-XX:+UseSerialGC','-XX:ActiveProcessorCount=2','-XX:+ErrorFileToStderr','-javaagent:'+agent,'-Dconsumer.core='+path.join(runtime,'native/libklepton-jvm.dylib'),'-Dconsumer.binding='+path.join(runtime,'native/libnativebinding.dylib'),'-Dconsumer.helper='+helper,'-Dndk.runtime='+runtime,'-Dbionic.abi='+path.join(runtime,'native/bionic/libaim_linux_abi.dylib'),'-Dbionic.root='+image.systemRoot,'-Dbionic.map='+path.join(state,'namespace-path-map'),'-Dbionic.runtime='+path.join(data,'kernel'),'-cp',cp,'maclauncher.android.bridge.ChoreographerProbe',inputs,agent];
 const baseline=process.env.ANDROID_CHOREOGRAPHER_BASELINE==='1';
 const result=spawnSync(sandbox.command,args,{env:{...sandbox.environment,...sandbox.graphics,...(baseline?{CHOREOGRAPHER_BASELINE_CONTROL:'1'}:{})},encoding:'utf8',timeout:25000,maxBuffer:4<<20,cwd:path.join(data,'files')});
 fs.writeFileSync(path.join(output,'stdout.log'),result.stdout||'');fs.writeFileSync(path.join(output,'stderr.log'),result.stderr||'');fs.writeFileSync(path.join(output,'RESULT.json'),JSON.stringify({status:result.status,signal:result.signal,error:result.error?.message,runtime,source:native,baseline,noGameOrGpu:true},null,2)+'\n');
 assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
 if(baseline){assert.match(result.stdout,/PASS original guest Choreographer rejects host-only Looper TLS/);assert.match(result.stderr,/Choreographer original owner status=0 line=73 callbacks=0/);}
 else{assert.match(result.stdout,/PASS original Bionic native Choreographer shares Java\/native ALooper/);assert.match(result.stderr,/Choreographer original owner status=0 line=0 callbacks=18 detached=9 failures=0 legacy=1 vsync=1 refresh=2 delayed=1 reposted=3/);assert.match(result.stderr,/Original libandroid surface symbols=431 fallbackCalls=6 missingLookup=1/);}
 t.diagnostic('Evidence '+output);
});
