const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync,spawnSync,spawn}=require('node:child_process');
const {once}=require('node:events');
const {pathToFileURL}=require('node:url');

const configured=process.env.ANDROID_ART_FRAMEWORK_JAR&&process.env.ANDROID_ART_HOOKS_JAR&&process.env.ANDROID_DEX_TOOLS;
test('ART DEX platform delegation preserves complete original APIs, bodies, hidden API flags and resources',
 {skip:!configured,timeout:90000},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-dex-bodies-'));
 try{
  const root=path.resolve(__dirname,'..'),tools=path.resolve(process.env.ANDROID_DEX_TOOLS);
  const jdk=process.env.JAVA_HOME||execFileSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).trim();
  const dependencies={dexlib2:path.join(tools,'smali-dexlib2-3.0.10.jar'),guava:path.join(tools,'guava-31.1-android.jar'),annotations:path.join(tools,'jsr305-3.0.2.jar')};
  const {buildDexBodies,delegateDexBodies}=await import(pathToFileURL(path.join(root,'src/modules/android/art/dex-bodies.mjs')));
  const tool=await buildDexBodies({output:path.join(directory,'tool'),jdk,dependencies});
  const bodies=path.join(root,'src/modules/android/art/adapters/framework-bodies'),output=path.join(directory,'framework.jar');
  delegateDexBodies({input:process.env.ANDROID_ART_FRAMEWORK_JAR,bodies,targets:process.env.ANDROID_ART_HOOKS_JAR,output,tool});
  const classes=path.join(directory,'probe'),classpath=tool.arguments[2];
  execFileSync(path.join(jdk,'bin/javac'),['--release','21','-cp',classpath,'-d',classes,path.join(root,'tests/fixtures/android-art-dex/DexBodiesProbe.java')],{stdio:'pipe'});
  const result=execFileSync(tool.command,['-Xmx768m','-cp',[classes,classpath].join(path.delimiter),'maclauncher.build.DexBodiesProbe',process.env.ANDROID_ART_FRAMEWORK_JAR,output,bodies],{encoding:'utf8'});
  assert.match(result,/Preserved \d+ original classes and \d+ hidden-API members; delegated 1 body/);
  const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,KLEPTON_NATIVE_RUNTIME:runtime,ANDROID_R8:r8}=process.env;
  if(payload&&runner&&runtime&&r8){
   const uiClasses=path.join(directory,'ui-classes'),dex=path.join(directory,'ui-dex');fs.mkdirSync(uiClasses);fs.mkdirSync(dex);
   const host=path.resolve(runtime,'android-host.jar'),api=path.resolve(runtime,'android-framework.jar');
   execFileSync(path.join(jdk,'bin/javac'),['--release','21','-cp',[host,api].join(path.delimiter),'-d',uiClasses,path.join(root,'tests/fixtures/android-art-dex/UiHooksProbe.java')],{stdio:'pipe'});
   const probe=path.join(directory,'ui-probe.jar');execFileSync(path.join(jdk,'bin/jar'),['cf',probe,'-C',uiClasses,'.'],{stdio:'pipe'});
   execFileSync(path.join(jdk,'bin/java'),['-cp',r8,'com.android.tools.r8.D8','--min-api','36','--lib',api,'--output',dex,host,probe],{stdio:'pipe'});
   const original=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));
   const supplier={...original,components:{...original.components,frameworkJar:output,bootstrapDex:path.join(dex,'classes.dex')}};
   const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
   const state=path.join(directory,'state');fs.mkdirSync(state);
   const properties=path.join(directory,'properties');execFileSync(supplier.components.bootstrap,[supplier.components.image,properties],{stdio:'pipe'});
   const map=publishPathMap(state,'ui-proof',prepareMountParents(layout({supplier,state})+'ro\t/system/lib64/libandroid-log-stderr.so\t'+supplier.components.logLibrary+'\nro\t/dev/__properties__\t'+properties+'\n',path.join(directory,'mounts')));
   for(const name of ['dev/__properties__','dev/socket','dev/pts'])fs.mkdirSync(path.join(state,'run',name),{recursive:true});
   const binderName='maclauncher.android.ui-proof.'+require('node:crypto').randomUUID();
   const binder=spawn(supplier.components.binder,['--service',binderName],{stdio:'ignore',detached:true});
   try {
   execFileSync(supplier.components.bootstrap,['wait-binder',binderName],{timeout:6000});
   const env=environment(supplier),args=['--inherit-env','--guest-fds','0,1,2','--binder',binderName,'--path-map',map,'--no-cache'];env.CLASSPATH='/system/framework/maclauncher.jar';
   const run=command=>{const result=spawnSync(runner,[...args,...command],{env,encoding:'utf8',timeout:60000,maxBuffer:4<<20});assert.equal(result.status,0,(result.stdout+result.stderr).slice(-20000)+'\n'+(result.error||result.signal||''));return result.stdout+result.stderr;};
   run(['/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig']);
   env.LD_PRELOAD='/system/lib64/libandroid-log-stderr.so';
   assert.match(run(['/system/bin/app_process64','-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','-Xverify:all','/system/bin','UiHooksProbe']),/PASS original ART ViewRoot completion, handled\/unhandled results, input-token fallback and retirement/);
   t.diagnostic('Original app_process64 executed the same callback owner and original ViewRoot methods');
   } finally {
    if(binder.exitCode===null&&binder.signalCode===null){const closed=once(binder,'close');process.kill(-binder.pid,'SIGTERM');await closed;}
   }
  }
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});


test('ART original PendingIntent destinations use the same complete JVM call binding',
 {skip:!process.env.ANDROID_ART_SERVICES_JAR||!configured,timeout:90000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-pending-dex-'));
 try{
  const tools=path.resolve(process.env.ANDROID_DEX_TOOLS),jdk=process.env.JAVA_HOME||execFileSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).trim();
  const {buildDexBodies,delegateDexBodies}=await import('../src/modules/android/art/dex-bodies.mjs');
  const tool=await buildDexBodies({output:path.join(directory,'tool'),jdk,dependencies:{dexlib2:path.join(tools,'smali-dexlib2-3.0.10.jar'),guava:path.join(tools,'guava-31.1-android.jar'),annotations:path.join(tools,'jsr305-3.0.2.jar')}});
  const output=path.join(directory,'services.jar');delegateDexBodies({input:process.env.ANDROID_ART_SERVICES_JAR,bodies:path.resolve('src/modules/android/art/adapters/service-bodies'),targets:process.env.ANDROID_ART_HOOKS_JAR,output,tool});
  const classes=path.join(directory,'probe'),cp=tool.arguments[2];
  execFileSync(path.join(jdk,'bin/javac'),['--release','21','-cp',cp,'-d',classes,...['DexBodiesProbe','DexServiceCallsProbe'].map(name=>path.resolve('tests/fixtures/android-art-dex',name+'.java'))]);
  const result=execFileSync(tool.command,['-Xmx768m','-cp',classes+path.delimiter+cp,'maclauncher.build.DexServiceCallsProbe',process.env.ANDROID_ART_SERVICES_JAR,output],{encoding:'utf8'});assert.match(result,/PASS .*shared PendingIntent calls/);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
