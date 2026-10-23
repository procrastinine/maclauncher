const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process'),{once}=require('node:events');

test('Original ART local Binder preserves endpoints and adopts native callers through the existing VM owner',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_GUEST_INPUTS:inputs,ANDROID_ART_BINDER_LIBRARY:corrected,JAVA_HOME:jdk,ANDROID_R8:r8}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,inputs,corrected,jdk,r8].every(Boolean))return t.skip('Requires an ART supplier, canonical native inputs, corrected Binder, JDK and D8');
 const retained=process.env.ANDROID_ART_TEST_OUTPUT,root=fs.mkdtempSync(path.join(retained?path.resolve(retained):os.tmpdir(),'android-local-binder-'));
 if(!retained)t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50}));
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload)),c=supplier.components,options=JSON.parse(fs.readFileSync(inputs));
 const execute=(program,args,extra={})=>{const r=spawnSync(program,args,{cwd:options.sourceRoot,encoding:'utf8',timeout:30000,maxBuffer:2<<20,...extra});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 const classes=path.join(root,'classes'),dex=path.join(root,'dex');fs.mkdirSync(classes);fs.mkdirSync(dex);
 execute(path.join(jdk,'bin/javac'),['--release','21','-cp',[path.resolve(payload,'android-host.jar'),path.resolve(payload,'android-framework.jar')].join(path.delimiter),'-d',classes,path.resolve('tests/fixtures/android-art/LocalBinderThreadProbe.java')]);
 const jar=path.join(root,'probe.jar');execute(path.join(jdk,'bin/jar'),['cf',jar,'-C',classes,'.']);
 execute(path.join(jdk,'bin/java'),['-cp',path.resolve(r8),'com.android.tools.r8.D8','--min-api','36','--lib',path.resolve(payload,'android-framework.jar'),'--output',dex,jar]);
 const object=path.join(root,'probe.o'),library=path.join(root,'probe.so'),prepared=path.join(options.output,'source');
 const includes=[path.join(prepared,'adapter'),path.join(prepared,'binder/include'),path.join(prepared,'binder'),...options.includeDirectories];
 execute(options.compiler,[...includes.map(d=>'-I'+d),...options.binderFlags,'-fPIC','-c',path.resolve('tests/fixtures/android-art/LocalBinderThreadProbe.cpp'),'-o',object]);
 execute(options.linkCompiler,['-shared','-nostdlib++','-Wl,--no-undefined',object,...[path.dirname(path.resolve(corrected)),path.join(c.image,'system/lib64'),...(options.libraryDirectories||[])].map(d=>'-L'+d),'-lbinder','-lbinder_ndk','-lutils','-l:libc++.so','-o',library]);
 const originalArt=process.env.ANDROID_ART_ORIGINAL_BUILD;
 let bootLibrary;
 if(process.env.ANDROID_ART_BOOT_IMAGE){
  assert.ok(originalArt,'The original ART build supplies the exact native API headers and compile flags');
  const ninja=fs.readFileSync(path.join(originalArt,'build.ninja'),'utf8'),flags=ninja.match(/build [^\n]*\/runtime\/runtime.cc.o: cxx[^\n]*\n  flags = ([^\n]*)/);
  assert.ok(flags,'Original ART runtime compile command');
  const bootObject=path.join(root,'boot-image-space.o');bootLibrary=path.join(root,'boot-image-space.so');
  const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
  const originalCompiler=ninja.match(/^cxx = (.+)$/m),target=ninja.match(/^target = (.+)$/m);assert.ok(originalCompiler&&target,'Original ART compiler and target');
  const clientFlags=flags[1].replace(' -DBUILDING_LIBART','').replace('-fvisibility=protected','-fvisibility=default');
  execute('/bin/sh',['-c',quote(originalCompiler[1])+' '+target[1]+' '+clientFlags+' -std=gnu++20 -c '+quote(path.resolve('tests/fixtures/android-art/BootImageSpaceProbe.cpp'))+' -o '+quote(bootObject)]);
  execute(options.linkCompiler,['-shared','-nostdlib++','-Wl,--no-undefined',bootObject,'-L'+path.join(c.image,'system/lib64'),'-l:libc++.so','-L'+path.join(c.image,'apex/com.android.runtime/lib64/bionic'),'-ldl_android','-ldl','-o',bootLibrary]);
 }
 const {layout,environment,prepareMountParents,publishPathMap}=await import('../src/modules/android/art/layout.mjs');
 const state=path.join(root,'state'),composition=path.join(root,'composition'),byPid=path.join(composition,'by-pid');for(const d of[state,composition,byPid])fs.mkdirSync(d,{recursive:true});
 const env={...environment(supplier),LD_LIBRARY_PATH:'/system/lib64',LD_PRELOAD:'/system/lib64/libandroid-log-stderr.so',KL_ANDROID_ID_DIRECTORY:path.join(root,'ids'),TMPDIR:path.join(root,'ipc')};for(const d of[env.KL_ANDROID_ID_DIRECTORY,env.TMPDIR])fs.mkdirSync(d,{mode:0o700});
 const children=[],alive=p=>p.exitCode===null&&p.signalCode===null;
 const launch=(name,program,args)=>{const log=fs.openSync(path.join(root,name+'.log'),'w');try{const child=spawn(program,args,{env,detached:true,stdio:['ignore',log,log]});children.push(child);return child;}finally{fs.closeSync(log);}};
 const stop=async child=>{if(!alive(child))return;const closed=once(child,'close');try{process.kill(-child.pid,'SIGTERM');}catch{}let timer;await Promise.race([closed,new Promise(resolve=>timer=setTimeout(resolve,2000))]);clearTimeout(timer);if(alive(child))try{process.kill(-child.pid,'SIGKILL');}catch{}await closed;};
 try{
  const properties=launch('properties',c.bootstrap,['serve',c.image,composition,byPid]);const until=Date.now()+10000;
  while(!fs.existsSync(path.join(composition,'sockets/property_service'))){assert.ok(alive(properties),fs.readFileSync(path.join(root,'properties.log'),'utf8'));assert.ok(Date.now()<until,'Property setup timed out');await new Promise(resolve=>setTimeout(resolve,20));}
  const binderName='maclauncher.local-binder.'+crypto.randomUUID();launch('binder',c.binder,['--host-module',c.hostLibrary,'--service',binderName]);execute(c.bootstrap,['wait-binder',binderName],{env});
  let text=layout({supplier,state});for(const name of['dev/__properties__','dev/socket','dev/pts'])fs.mkdirSync(path.join(state,'run',name),{recursive:true});
  const mounts=[['ro','/dev/__properties__',path.join(composition,'properties')],['rw','/dev/socket/property_service',path.join(composition,'sockets/property_service')],['rw','/dev/socket/property_service_for_system',path.join(composition,'sockets/property_service_for_system')],['ro','/system/lib64/libandroid-log-stderr.so',c.logLibrary],['ro','/system/lib64/local-binder-thread-probe.so',library],['ro','/data/local/tmp/local-binder.dex',path.join(dex,'classes.dex')]];
  if(bootLibrary)mounts.push(['ro','/system/lib64/boot-image-space-probe.so',bootLibrary]);
  text=mounts.map(row=>row.join('\t')).join('\n')+'\n'+text;
  const bootRoot=process.env.ANDROID_ART_BOOT_IMAGE&&path.resolve(process.env.ANDROID_ART_BOOT_IMAGE),boot=bootRoot&&JSON.parse(fs.readFileSync(path.join(bootRoot,'boot-image.json')));
  const mapFor=(label,binder,useImage=false)=>publishPathMap(state,label,prepareMountParents((useImage?boot.files.map(file=>'ro\t/system/'+file+'\t'+path.join(bootRoot,file)+'\n').join(''):'')+'ro\t/system/lib64/libbinder.so\t'+binder+'\n'+text,path.join(root,'parents')));
  const args=map=>['--inherit-env','--guest-fds','0,1,2','--binder',binderName,'--by-pid',byPid,'--path-map',map,'--cache',path.join(root,'cache'),'--host-module',c.hostLibrary];
  const map=mapFor('corrected',path.resolve(corrected));execute(c.linuxRun,[...args(map),'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});
  env.CLASSPATH+=':/data/local/tmp/local-binder.dex';env.BOOTCLASSPATH+=':/data/local/tmp/local-binder.dex';
  const app=(map,useImage=false)=>[...args(map),'--identity-text','service\tlocal-binder-probe\nuid\t10021\ngid\t10021\ncap_effective\t0\ncap_permitted\t0\ncap_bounding\t0\nseclabel\tu:r:untrusted_app:s0\n','/system/bin/app_process64',useImage?'-Ximage:'+boot.location:'-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat',...(boot?['-verbose:startup']:[]),'/system/bin','maclauncher.android.LocalBinderThreadProbe',String(process.getuid()),...(boot?[String(useImage)]:[])];
  if(process.env.ANDROID_ART_BINDER_BASELINE){
   const before=spawnSync(c.linuxRun,app(mapFor('baseline',path.resolve(process.env.ANDROID_ART_BINDER_BASELINE))),{env,encoding:'utf8',timeout:30000,maxBuffer:2<<20});
   fs.writeFileSync(path.join(root,'baseline.log'),before.stdout+before.stderr);assert.ifError(before.error);assert.equal(before.signal,'SIGABRT',before.stdout+before.stderr);assert.match(before.stderr,/Binder thread started or Java binder used, but env null/);
  }
  const started=performance.now(),result=execute(c.linuxRun,app(map),{env}),unimagedMs=performance.now()-started;fs.writeFileSync(path.join(root,'corrected.log'),result.stdout+result.stderr);
  assert.match(result.stdout,/PASS original local Binder identity, Parcel callbacks and native-thread attachment retirement/);
  if(boot){
   // Original dalvikvm and its native Runtime/Heap API expose actual image
   // ownership without requiring an Activity or an Android log daemon.
   const bootApp=(map,useImage)=>[...args(map),'/apex/com.android.art/bin/dalvikvm64',useImage?'-Ximage:'+boot.location:'-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','-cp','/data/local/tmp/local-binder.dex','maclauncher.android.LocalBinderThreadProbe$BootImageProbe',String(useImage)];
   const bootEnv=env;
   const bootStart=performance.now(),without=execute(c.linuxRun,bootApp(map,false),{env:bootEnv}),unimagedMs=performance.now()-bootStart;
   fs.writeFileSync(path.join(root,'boot-unimaged.log'),without.stdout+without.stderr);
   assert.match(without.stdout,/PASS original framework\/services\/adapters boot image execution/);
   assert.match(without.stdout,/boot image execution=false/,'Original ART reports no boot image space');
   const started=performance.now(),imaged=spawnSync(c.linuxRun,bootApp(mapFor('imaged',path.resolve(corrected),true),true),{env:bootEnv,encoding:'utf8',timeout:30000,maxBuffer:2<<20}),imagedMs=performance.now()-started;
   fs.writeFileSync(path.join(root,'imaged.log'),imaged.stdout+imaged.stderr);
   assert.ifError(imaged.error);assert.equal(imaged.signal,null,imaged.stdout+imaged.stderr);assert.equal(imaged.status,0,imaged.stdout+imaged.stderr);
   assert.match(imaged.stdout,/boot image execution=true/,'Original ART must report its actual boot image space');assert.match(imaged.stdout,/PASS original framework\/services\/adapters boot image execution/);
   fs.writeFileSync(path.join(root,'boot-result.json'),JSON.stringify({unimagedMs,imagedMs,bootClasspathJars:boot.bootClasspath.length,files:boot.files.length,scope:'One headless matched component comparison, not a game/FPS measurement.'},null,2)+'\n');
   t.diagnostic(JSON.stringify({unimagedMs,imagedMs,bootFiles:boot.files.length}));
   if(process.env.ANDROID_AIM_SOURCE){const{buildBootImage}=await import('../src/modules/android/art/boot-image.mjs');const reused=await buildBootImage({output:path.dirname(bootRoot),aim:path.resolve(process.env.ANDROID_AIM_SOURCE),components:c,bootClasspath:supplier.bootClasspath,rustc:'must-not-run-for-a-cached-image'});assert.equal(reused.root,bootRoot);}
  }
  t.diagnostic('Evidence '+root);
 }finally{await Promise.all(children.reverse().map(stop));assert.ok(children.every(child=>!alive(child)),'Owned component services retired');}
});
