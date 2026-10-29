const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');
async function windowProof(t,redirect=false){
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires the Android native runtime and JDK21');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-activity-window-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const cp=[temp,...['android-host.jar','android-framework.jar','apksig.jar'].map(n=>path.resolve(runtime,n))].join(path.delimiter),env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 const identities=path.join(temp,'ids');fs.mkdirSync(identities,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=fs.realpathSync(identities);
 function run(exe,args){const r=spawnSync(exe,args,{encoding:'utf8',env,timeout:30000,maxBuffer:4<<20});assert.equal(r.error,undefined,r.error?.message+'\n'+r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;}
 const shared=path.resolve('src/modules/android/native/java/maclauncher/android'),art=path.resolve('src/modules/android/art/java/maclauncher/android'),fixture=path.resolve('tests/fixtures/android-framework-services');
 const sources=['framework/HostActivity.java','framework/HostActivityTasks.java','framework/HostActivityService.java','framework/HostWindowManager.java','framework/HostDisplay.java','framework/HostInput.java','framework/HostTextInput.java','framework/HostLooper.java','bridge/WindowSession.java','Host.java'].map(n=>path.join(shared,n));
 sources.push(...fs.readdirSync(art).filter(n=>n.endsWith('.java')).map(n=>path.join(art,n)),...['ArtWindowBindingProbe','HostWindowProcessProbe','HostWindowProbe','PackageManifest','SyntheticResources'].map(n=>path.join(fixture,n+'.java')),...['LayoutInflationProbe','ResourceFixtureData'].map(n=>path.join(fixture,'../android-native/'+n+'.java')));
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temp,...sources]);
 const result=await require('./helpers/android-platform-window').platformWindow({runtime,home,root:fs.realpathSync(temp),classpath:cp,args:['-Xverify:all','-Dandroid.fixture.input=maclauncher.android.ArtWindowBindingProbe',...(redirect?['-Dandroid.fixture.windowRedirect=true']:[])],env});
 assert.equal(result.status,0,result.stdout+result.stderr);const output=result.stdout;
 assert.match(output,redirect?/PASS original finish-before-launch redirect: successor survives, final task retirement ends the ART loop/:/PASS typed activity windows: initial and service allocation, original ViewRoot\/lifecycle, capability options and surviving application/);
 if(redirect){assert.match(output,/PASS physical input capability: original MessageQueue pipe delivery survives Activity replacement/);assert.match(output,/PASS first draw ownership: original traversal survives Activity detachment before observer removal/);t.diagnostic(output.split('\n').find(line=>line.startsWith('PASS first draw ownership:')));}
 if(!redirect){assert.match(output,/PASS physical close intent: original queue notifies the shared authority before exit; EOF and retirement preserve failure detection/);t.diagnostic(output.split('\n').find(line=>line.startsWith('PASS delegated focus retirement:')));}
}
test('initial and service Activities share the installed physical window binding and original lifecycle',t=>windowProof(t));
test('queued finish-before-launch preserves the original successor and the ART presentation loop',t=>windowProof(t,true));

test('initial and navigated Activity callbacks observe finishing before original pause stop and destroy',async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires the Android native runtime and JDK21');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-activity-finishing-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const cp=[temp,...['android-host.jar','android-framework.jar','apksig.jar'].map(n=>path.resolve(runtime,n))].join(path.delimiter),env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 const identities=path.join(temp,'ids');fs.mkdirSync(identities,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=fs.realpathSync(identities);
 const fixture=path.resolve('tests/fixtures/android-framework-services');
 const sources=[path.resolve('src/modules/android/native/java/maclauncher/android/framework/HostActivity.java'),...['ActivityFinishingProbe','HostWindowProbe','PackageManifest','SyntheticResources'].map(n=>path.join(fixture,n+'.java')),...['LayoutInflationProbe','ResourceFixtureData'].map(n=>path.join(fixture,'../android-native/'+n+'.java'))];
 const compiled=spawnSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temp,...sources],{encoding:'utf8',env,timeout:30000,maxBuffer:4<<20});assert.equal(compiled.error,undefined,compiled.error?.message);assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
 const result=await require('./helpers/android-platform-window').platformWindow({runtime,home,root:fs.realpathSync(temp),classpath:cp,args:['-Xverify:all','-Dandroid.fixture.input=maclauncher.android.ActivityFinishingProbe'],env});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS original initial and navigated Activity callbacks observe finishing before pause, stop and destroy/);
});

test('original Activity Up navigation retains task ownership Intent results and lifecycle',async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires the Android native runtime and JDK21');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-activity-up-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const cp=[temp,...['android-host.jar','android-framework.jar','apksig.jar'].map(n=>path.resolve(runtime,n))].join(path.delimiter),env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 const identities=path.join(temp,'ids');fs.mkdirSync(identities,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=fs.realpathSync(identities);
 const fixture=path.resolve('tests/fixtures/android-framework-services'),source=path.resolve('src/modules/android/native/java/maclauncher/android/framework');
 const sources=[...['HostActivity','HostActivityTasks'].map(n=>path.join(source,n+'.java')),...['ActivityUpNavigationProbe','HostWindowProbe','PackageManifest','SyntheticResources'].map(n=>path.join(fixture,n+'.java')),...['LayoutInflationProbe','ResourceFixtureData'].map(n=>path.join(fixture,'../android-native/'+n+'.java'))];
 const compiled=spawnSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temp,...sources],{encoding:'utf8',env,timeout:30000,maxBuffer:4<<20});assert.equal(compiled.error,undefined,compiled.error?.message);assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
 const result=await require('./helpers/android-platform-window').platformWindow({runtime,home,root:fs.realpathSync(temp),classpath:cp,args:['-Xverify:all','-Dandroid.fixture.input=maclauncher.android.ActivityUpNavigationProbe'],env});
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/PASS original Up navigation: parent reuse, Intent, result and finishing lifecycle/);
});

test('original finish-before-start handoff survives a budgeted physical display turn',async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires the Android native runtime and JDK21');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-activity-handoff-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const cp=[temp,...['android-host.jar','android-framework.jar','apksig.jar'].map(n=>path.resolve(runtime,n))].join(path.delimiter),env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 const identities=path.join(temp,'ids');fs.mkdirSync(identities,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=fs.realpathSync(identities);
 const fixture=path.resolve('tests/fixtures/android-framework-services');
 const sources=[path.resolve('src/modules/android/native/java/maclauncher/android/framework/HostActivity.java'),...['ActivityLaunchHandoffProbe','HostWindowProbe','PackageManifest','SyntheticResources'].map(n=>path.join(fixture,n+'.java')),...['LayoutInflationProbe','ResourceFixtureData'].map(n=>path.join(fixture,'../android-native/'+n+'.java'))];
 const compiled=spawnSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temp,...sources],{encoding:'utf8',env,timeout:30000,maxBuffer:4<<20});assert.equal(compiled.error,undefined,compiled.error?.message);assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
 const result=await require('./helpers/android-platform-window').platformWindow({runtime,home,root:fs.realpathSync(temp),classpath:cp,args:['-Xverify:all','-Dandroid.fixture.input=maclauncher.android.ActivityLaunchHandoffProbe'],env});
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/PASS original finish-before-start handoff: queued successor survives a display-turn boundary and final task retires/);
});

test('shared output retirement preserves the first failure and drains the existing owner queue',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires the Android native runtime and JDK21');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-output-retirement-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const cp=[temp,...['android-host.jar','android-framework.jar'].map(n=>path.resolve(runtime,n))].join(path.delimiter);
 const env={...process.env};for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 const ids=path.join(temp,'ids');fs.mkdirSync(ids,{mode:0o700});env.KL_ANDROID_ID_DIRECTORY=fs.realpathSync(ids);
 const run=(executable,args)=>{const result=spawnSync(executable,args,{encoding:'utf8',env,timeout:30000,maxBuffer:2<<20});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);assert.doesNotMatch(result.stdout+result.stderr,/FATAL ERROR in native method|WARNING in native method/);return result.stdout;};
 const shared=path.resolve(process.env.ANDROID_NATIVE_SOURCE||'src/modules/android/native','java/maclauncher/android');
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',temp,path.join(shared,'framework/HostActivity.java'),path.join(shared,'framework/HostWindowManager.java'),path.join(shared,'framework/HostLooper.java'),path.join(shared,'bridge/NativeCompositionWindow.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java'),path.resolve('tests/fixtures/android-framework-services/OutputRetirementProbe.java')]);
 const output=run(path.join(home,'bin/java'),['-Xverify:all','-cp',cp,'maclauncher.android.OutputRetirementProbe',path.resolve(runtime),temp]);
 assert.match(output,/PASS shared output retirement: first failure, suppressed cleanup, original owner queue and compositor-before-callback barrier/);
});

test('original ART input channel bounds stalled input and retires without UI progress',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_R8:r8,JAVA_HOME:java,KLEPTON_NATIVE_RUNTIME:runtime}=process.env;
 if(process.platform!=='darwin'||![payload,runner,r8,java,runtime].every(Boolean))return t.skip('Requires the matched ART image, runner, Android framework, Java and R8');
 const {spawnSync,spawn}=require('node:child_process'),{once}=require('node:events');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-input-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(exe,args,options={})=>{const r=spawnSync(exe,args,{encoding:'utf8',timeout:45000,maxBuffer:4<<20,...options});assert.equal(r.status,0,(r.stdout+r.stderr).slice(-12000)+'\n'+(r.error||r.signal||''));return r.stdout+r.stderr;};
 const classes=path.join(root,'classes'),dex=path.join(root,'dex');fs.mkdirSync(classes);fs.mkdirSync(dex);
 const api=path.resolve(runtime,'android-framework.jar');
 run(path.join(java,'bin/javac'),['--release','21','-cp',api,'-d',classes,path.resolve('src/modules/android/native/java/maclauncher/android/framework/HostLooper.java'),path.resolve('tests/fixtures/android-art-application/InputChannelProbe.java')]);
 const jar=path.join(root,'probe.jar');run(path.join(java,'bin/jar'),['cf',jar,'-C',classes,'.']);
 run(path.join(java,'bin/java'),['-cp',r8,'com.android.tools.r8.D8','--min-api','36','--lib',api,'--output',dex,jar]);
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);const properties=path.join(root,'properties');run(supplier.components.bootstrap,[supplier.components.image,properties]);
 const map=publishPathMap(state,'channel-proof',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/probe.dex\t'+path.join(dex,'classes.dex')+'\nro\t/system/lib64/libandroid-log-stderr.so\t'+supplier.components.logLibrary+'\nro\t/dev/__properties__\t'+properties+'\n',path.join(root,'mounts')));
 for(const name of ['dev/__properties__','dev/socket','dev/pts'])fs.mkdirSync(path.join(state,'run',name),{recursive:true});
 const binderName='maclauncher.android.input-proof.'+require('node:crypto').randomUUID(),binder=spawn(supplier.components.binder,['--service',binderName],{stdio:'ignore',detached:true});
 try{
  run(supplier.components.bootstrap,['wait-binder',binderName]);const env=environment(supplier);env.CLASSPATH='/data/local/tmp/probe.dex';env.BOOTCLASSPATH=env.BOOTCLASSPATH.replace('/system/framework/maclauncher.jar','/data/local/tmp/probe.dex:/system/framework/maclauncher.jar');
  const base=['--inherit-env','--guest-fds','0,1,2','--binder',binderName,'--path-map',map,'--no-cache'];
  run(runner,[...base,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});env.LD_PRELOAD='/system/lib64/libandroid-log-stderr.so';
  const result=run(runner,[...base,'/system/bin/app_process64','-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','-Xverify:all','/system/bin','InputChannelProbe'],{env,timeout:10000});
  assert.match(result,/PASS original ART retirement queue: ready callbacks, future work, sync barrier, repeated release and surviving Looper/);
  assert.match(result,/PASS original ART InputChannel: bounded queue \d+, peer retirement without UI progress, asynchronous handled\/unhandled completion/);t.diagnostic(result.split('\n').find(line=>line.includes('PASS original ART')));
 }finally{if(binder.exitCode===null&&binder.signalCode===null){const closed=once(binder,'close');process.kill(-binder.pid,'SIGTERM');await closed;}}
});
