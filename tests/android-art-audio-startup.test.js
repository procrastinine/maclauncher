const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process'),{once}=require('node:events');

test('native audio publication joins the original permission barrier before completing',{timeout:45000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_AUDIO_STARTUP_PROBE:probe}=process.env;
 if(process.platform!=='darwin'||!payload||!probe)return t.skip('Requires original ART supplier and native audio publication component');
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload)),c=supplier.components;
 const {layout,environment,publishPathMap,prepareMountParents}=await import('../src/modules/android/art/layout.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-audio-startup-')),state=path.join(root,'state'),composition=path.join(root,'composition'),byPid=path.join(composition,'by-pid');
 for(const p of[state,composition,byPid])fs.mkdirSync(p,{recursive:true});
 const children=[],alive=p=>p.exitCode==null&&p.signalCode==null;
 const remove=p=>{fs.chmodSync(p,0o700);for(const e of fs.readdirSync(p,{withFileTypes:true}))if(e.isDirectory())remove(path.join(p,e.name));fs.rmSync(p,{recursive:true,force:true});};
 t.after(async()=>{for(const p of children.toReversed())if(alive(p))try{process.kill(-p.pid,'SIGTERM');}catch{}let timer;await Promise.race([Promise.allSettled(children.map(p=>p.closed)),new Promise(r=>timer=setTimeout(r,1500))]);clearTimeout(timer);for(const p of children)if(alive(p))try{process.kill(-p.pid,'SIGKILL');}catch{}await Promise.allSettled(children.map(p=>p.closed));assert.ok(children.every(p=>!alive(p)));remove(root);});
 const env={...process.env,...environment(supplier),...(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment,TMPDIR:path.join(root,'ipc')};fs.mkdirSync(env.TMPDIR,{mode:0o700});
 const run=(program,args)=>{const result=spawnSync(program,args,{env,encoding:'utf8',timeout:20000,maxBuffer:2<<20});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 const start=(name,program,args)=>{const p=spawn(program,args,{env,detached:true,stdio:['ignore','pipe','pipe']});p.output='';p.closed=once(p,'close');p.closed.catch(()=>{});for(const stream of[p.stdout,p.stderr])stream.on('data',bytes=>p.output+=bytes);children.push(p);return p;};
 const marker=async(p,text)=>{const end=Date.now()+10000;while(!p.output.includes(text)){assert.ok(alive(p),p.output);assert.ok(Date.now()<end,p.output);await new Promise(r=>setTimeout(r,10));}};
 const properties=start('properties',c.bootstrap,['serve',c.image,composition,byPid]);await marker(properties,'Original native property service ready');
 const binderName='maclauncher.audio-startup.'+crypto.randomUUID();start('binder',c.binder,['--host-module',c.hostLibrary,'--service',binderName]);run(c.bootstrap,['wait-binder',binderName]);
 const rows=[['ro','/system/bin/audio-startup-probe',path.resolve(probe)],['ro','/system/lib64/libbinder.so',c.binderLibrary],['ro','/system/lib64/libandroid-log-stderr.so',c.logLibrary],['ro','/dev/__properties__',path.join(composition,'properties')],['rw','/dev/socket/property_service',path.join(composition,'sockets/property_service')],['rw','/dev/socket/property_service_for_system',path.join(composition,'sockets/property_service_for_system')]];
 const map=publishPathMap(state,'audio-startup',prepareMountParents(rows.map(r=>r.join('\t')+'\n').join('')+layout({supplier,state}),path.join(root,'parents')));
 const args=['--inherit-env','--guest-fds','0,1,2','--binder',binderName,'--by-pid',byPid,'--path-map',map,'--cache',path.join(root,'cache'),'--host-module',c.hostLibrary];
 const identity=uid=>'service\taudio-startup\nuid\t'+uid+'\ngid\t'+uid+'\ncap_effective\t0\ncap_permitted\t0\ncap_bounding\t0\nseclabel\tu:r:system_server:s0\n';
 run(c.linuxRun,[...args,'--identity-text',identity(0),'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig']);
 env.LD_PRELOAD='/system/lib64/libandroid-log-stderr.so';start('servicemanager',c.linuxRun,[...args,'--identity-text',identity(1000),'/system/bin/servicemanager']);
 const output=run(c.linuxRun,[...args,'--identity-text',identity(1000),'/system/bin/audio-startup-probe']);assert.match(output,/PASS original native audio publication waits for complete permission replay once/);
});

test('the original system permission provider publishes every native permission family with real package UIDs',{timeout:30000},async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires Android runtime and Java21');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-audio-permissions-')),classes=path.join(root,'classes');fs.mkdirSync(classes);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const cp=['android-host.jar','android-framework.jar'].map(name=>path.join(path.resolve(runtime),name)).join(path.delimiter),source=path.join(__dirname,'fixtures/android-platform-service/NativeAudioPermissionProbe.java');
 const run=(program,args,env=process.env)=>{const result=spawnSync(program,args,{env,encoding:'utf8',timeout:20000,maxBuffer:2<<20});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 run(home+'/bin/javac',['--release','21','-cp',cp,'-d',classes,source]);
 const env={...process.env,...(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment};
 const output=run(home+'/bin/java',[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-cp',classes+path.delimiter+cp,'maclauncher.android.framework.NativeAudioPermissionProbe',path.resolve(runtime),path.join(root,'data')],env);
 assert.match(output,/PASS original system package\/UID and all native permission vectors/);
});
