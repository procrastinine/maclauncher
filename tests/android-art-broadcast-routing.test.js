const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync,spawn}=require('node:child_process'),{once}=require('node:events');
test('shared remote broadcasts run concurrently on original ART core APIs and retire their executor',{timeout:45000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,JAVA_HOME:java,ANDROID_R8:r8,ANDROID_ART_CORE_API:core}=process.env;
 if(process.platform!=='darwin'||![payload,java,r8,core].every(Boolean))return t.skip('Requires original ART supplier, Java, R8 and Android core compiler declarations');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-broadcast-'));let binder;
 t.after(async()=>{if(binder&&binder.exitCode===null&&binder.signalCode===null){const closed=once(binder,'close'),timer=setTimeout(()=>{try{process.kill(-binder.pid,'SIGKILL');}catch{}},1500);try{process.kill(-binder.pid,'SIGTERM');await closed;}finally{clearTimeout(timer);}}
  const writable=p=>{fs.chmodSync(p,0o700);for(const e of fs.readdirSync(p,{withFileTypes:true}))if(e.isDirectory())writable(path.join(p,e.name));};writable(root);fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});});
 const retained=process.env.ANDROID_ART_BROADCAST_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});
 const run=(binary,args,env=process.env,capture=false)=>{const r=spawnSync(binary,args,{env,encoding:'utf8',timeout:30000,maxBuffer:4<<20});if(capture&&retained){fs.writeFileSync(path.join(retained,'stdout.log'),r.stdout||'');fs.writeFileSync(path.join(retained,'stderr.log'),r.stderr||'');}assert.ifError(r.error);assert.equal(r.signal,null,(r.stdout+r.stderr).slice(-12000));assert.equal(r.status,0,(r.stdout+r.stderr).slice(-12000));return r.stdout+r.stderr;};
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload)),c=supplier.components,classes=path.join(root,'classes'),dex=path.join(root,'dex');fs.mkdirSync(classes);fs.mkdirSync(dex);
 const api=payload+'/android-framework.jar',host=payload+'/android-host.jar';
 run(java+'/bin/javac',['--system',core,'-source','21','-target','21','-cp',[host,api].join(path.delimiter),'-d',classes,'src/modules/android/native/java/maclauncher/android/bridge/LocalBroadcasts.java','tests/fixtures/android-art/ArtBroadcastRoutingProbe.java']);run(java+'/bin/jar',['cf',root+'/probe.jar','-C',classes,'.']);
 run(java+'/bin/java',['-cp',r8,'com.android.tools.r8.D8','--min-api','36','--lib',api,'--classpath',host,'--output',dex,root+'/probe.jar']);
 const {layout,environment,prepareMountParents,publishPathMap}=await import('../src/modules/android/art/layout.mjs'),state=path.join(root,'state'),properties=path.join(root,'properties');fs.mkdirSync(state);run(c.bootstrap,[c.image,properties]);
 const mounts=[['ro','/data/local/tmp/broadcast-probe',root],['ro','/system/lib64/libandroid-log-stderr.so',c.logLibrary],['ro','/system/lib64/libbinder.so',c.binderLibrary],['ro','/dev/__properties__',properties]];
 const map=publishPathMap(state,'broadcast',prepareMountParents(layout({supplier,state})+mounts.map(row=>row.join('\t')+'\n').join(''),root+'/mounts'));
 const env={...environment(supplier),...(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment,LD_PRELOAD:'/system/lib64/libandroid-log-stderr.so',DYLD_FRAMEWORK_PATH:path.resolve(payload,'native')};
 env.BOOTCLASSPATH='/data/local/tmp/broadcast-probe/dex/classes.dex:'+env.BOOTCLASSPATH;env.CLASSPATH='/data/local/tmp/broadcast-probe/dex/classes.dex';
 const name='maclauncher.broadcast.'+require('node:crypto').randomUUID();binder=spawn(c.binder,['--host-module',c.hostLibrary,'--service',name],{env,stdio:'ignore',detached:true});run(c.bootstrap,['wait-binder',name],env);
 const base=['--inherit-env','--guest-fds','0,1,2','--binder',name,'--path-map',map,'--cache',root+'/cache','--host-module',c.hostLibrary];run(c.linuxRun,[...base,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],env);
 const output=run(c.linuxRun,[...base,'/system/bin/app_process64','-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','/system/bin','maclauncher.android.ArtBroadcastRoutingProbe'],env,true);
 assert.match(output,/PASS shared original-core broadcast routing: concurrent daemon delivery and owned retirement/);t.diagnostic(output.split('\n').find(line=>line.includes('PASS shared original-core')));
});
