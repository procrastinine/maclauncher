const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync,spawn}=require('node:child_process'),{once}=require('node:events');
test('original ART application font publication initializes native Paint and retains its map',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,KLEPTON_NATIVE_RUNTIME:runtime,JAVA_HOME:jdk,ANDROID_R8:r8}=process.env;
 if(process.platform!=='darwin'||![payload,runner,runtime,jdk,r8].every(Boolean))return t.skip('Requires the original ART image, Android runtime, Java and R8');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-system-fonts-'));let binder;
 t.after(async()=>{
  if(binder&&binder.exitCode===null&&binder.signalCode===null){const closed=once(binder,'close'),timer=setTimeout(()=>process.kill(-binder.pid,'SIGKILL'),2000);process.kill(-binder.pid,'SIGTERM');try{await closed;}finally{clearTimeout(timer);}}
  const writable=directory=>{fs.chmodSync(directory,0o700);for(const entry of fs.readdirSync(directory,{withFileTypes:true}))if(entry.isDirectory())writable(path.join(directory,entry.name));};writable(root);
  fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});
 });
 const run=(command,args,options={})=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:60000,maxBuffer:4<<20,...options});if(r.status!==0)t.diagnostic((r.stdout+r.stderr).slice(-12000));assert.ifError(r.error);assert.equal(r.status,0,(r.stdout+r.stderr).slice(-12000));return r.stdout+r.stderr;};
 const classes=path.join(root,'classes'),dex=path.join(root,'dex');fs.mkdirSync(classes);fs.mkdirSync(dex);
 const api=path.resolve(runtime,'android-framework.jar');
 run(path.join(jdk,'bin/javac'),['--release','8','-cp',api,'-d',classes,'src/modules/android/native/java/maclauncher/android/framework/HostSystemFonts.java','tests/fixtures/android-art-application/SystemFontsProbe.java']);
 const jar=path.join(root,'probe.jar');run(path.join(jdk,'bin/jar'),['cf',jar,'-C',classes,'.']);
 run(path.join(jdk,'bin/java'),['-cp',r8,'com.android.tools.r8.D8','--min-api','36','--lib',api,'--output',dex,jar]);
 const original=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));
 const supplier={...original,components:{...original.components,bootstrapDex:path.join(dex,'classes.dex')}};
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state');fs.mkdirSync(state);const properties=path.join(root,'properties');
 run(supplier.components.bootstrap,[supplier.components.image,properties]);
 const map=publishPathMap(state,'fonts',prepareMountParents(layout({supplier,state})+'ro\t/system/lib64/libandroid-log-stderr.so\t'+supplier.components.logLibrary+'\nro\t/dev/__properties__\t'+properties+'\n',path.join(root,'mounts')));
 for(const name of ['dev/__properties__','dev/socket','dev/pts'])fs.mkdirSync(path.join(state,'run',name),{recursive:true});
 const binderName='maclauncher.android.fonts.'+require('node:crypto').randomUUID();
 binder=spawn(supplier.components.binder,['--service',binderName],{stdio:'ignore',detached:true});
 run(supplier.components.bootstrap,['wait-binder',binderName]);
 const env=environment(supplier),base=['--inherit-env','--guest-fds','0,1,2','--binder',binderName,'--path-map',map,'--cache',path.join(root,'cache')];
 env.CLASSPATH='/system/framework/maclauncher.jar';
 run(runner,[...base,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});
 env.LD_PRELOAD='/system/lib64/libandroid-log-stderr.so';
 assert.match(run(runner,[...base,'/system/bin/app_process64','-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','/system/bin','SystemFontsProbe'],{env}),/PASS original ART font initialization, Paint measurement, Canvas pixels and retained map/);
});
