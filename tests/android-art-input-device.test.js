const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync,spawn}=require('node:child_process'),{once}=require('node:events');
test('Original ART device lookup resolves keyboard and pointer initialized before service installation',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_R8:r8,JAVA_HOME:java,KLEPTON_NATIVE_RUNTIME:runtime}=process.env;
 if(process.platform!=='darwin'||![payload,runner,r8,java,runtime].every(Boolean))return t.skip('Requires the matched ART image, runner, Android framework, Java and R8');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-input-device-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(exe,args,options={})=>{const result=spawnSync(exe,args,{encoding:'utf8',timeout:30000,maxBuffer:4<<20,...options});assert.ifError(result.error);assert.equal(result.status,0,(result.stdout+result.stderr).slice(-16000)+'\n'+(result.signal||''));return result.stdout+result.stderr;};
 const classes=path.join(root,'classes'),dex=path.join(root,'dex');fs.mkdirSync(classes);fs.mkdirSync(dex);
 const api=path.resolve(runtime,'android-framework.jar'),host=path.resolve(runtime,'android-host.jar');
 run(path.join(java,'bin/javac'),['--release','21','-cp',[host,api].join(path.delimiter),'-d',classes,path.resolve('tests/fixtures/android-test-input/ArtInputDeviceProbe.java')]);
 const jar=path.join(root,'probe.jar');run(path.join(java,'bin/jar'),['cf',jar,'-C',classes,'.']);
 run(path.join(java,'bin/java'),['-cp',r8,'com.android.tools.r8.D8','--min-api','36','--lib',api,'--classpath',host,'--output',dex,jar]);
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);const properties=path.join(root,'properties');run(supplier.components.bootstrap,[supplier.components.image,properties]);
 const map=publishPathMap(state,'input-device-proof',prepareMountParents(layout({supplier,state})+'ro\t/system/lib64/libbinder.so\t'+supplier.components.binderLibrary+'\nro\t/data/local/tmp/probe.dex\t'+path.join(dex,'classes.dex')+'\nro\t/system/lib64/libandroid-log-stderr.so\t'+supplier.components.logLibrary+'\nro\t/dev/__properties__\t'+properties+'\n',path.join(root,'mounts')));
 for(const name of ['dev/__properties__','dev/socket','dev/pts'])fs.mkdirSync(path.join(state,'run',name),{recursive:true});
 const binderName='maclauncher.android.input-device-proof.'+require('node:crypto').randomUUID(),binder=spawn(supplier.components.binder,['--service',binderName],{stdio:'ignore',detached:true});
 try{
  run(supplier.components.bootstrap,['wait-binder',binderName]);const env=environment(supplier);env.CLASSPATH='/data/local/tmp/probe.dex';env.BOOTCLASSPATH=env.BOOTCLASSPATH.replace('/system/framework/maclauncher.jar','/data/local/tmp/probe.dex:/system/framework/maclauncher.jar');
  const base=['--inherit-env','--guest-fds','0,1,2','--binder',binderName,'--path-map',map,'--no-cache'];
  run(runner,[...base,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});env.LD_PRELOAD='/system/lib64/libandroid-log-stderr.so';
  const result=run(runner,[...base,'/system/bin/app_process64','-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','-Xverify:all','/system/bin','ArtInputDeviceProbe',String(process.getuid())],{env,timeout:10000});
  assert.match(result,/PASS original ART input devices: initialize before install, ids=\[-1, 1\], MotionEvent.getDevice=1, local InputManagerGlobal, libinput keyboard and generation 1->2/);t.diagnostic(result.split('\n').find(line=>line.includes('PASS original ART')));
 }finally{if(binder.exitCode===null&&binder.signalCode===null){const closed=once(binder,'close');process.kill(-binder.pid,'SIGTERM');await closed;}}
});
