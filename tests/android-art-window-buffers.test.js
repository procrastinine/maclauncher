const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync,spawn}=require('node:child_process'),{once}=require('node:events');
const {componentSupplier}=require('./helpers/android-art-supplier');
test('original ART EGL follows dequeued producer geometry and cancels unused buffers',{timeout:60000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,JAVA_HOME:java,ANDROID_CLANG:clang,ANDROID_R8:r8,ANDROID_ART_GLES_LIBRARY:gles}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,java,clang,r8,gles].every(Boolean))return t.skip('Requires the ART image, guest GLES component, Android Clang, JDK and D8');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-window-buffers-')),children=[];let native;
 t.after(async()=>{
  await native?.close();
  const retired=children.every(child=>{try{process.kill(child.pid,0);return false;}catch(error){return error.code==='ESRCH';}});assert.equal(retired,true,'Exact owned native services retire');
  if(retained){for(const name of fs.readdirSync(root).filter(name=>name.endsWith('.log')))fs.copyFileSync(path.join(root,name),path.join(retained,name));fs.writeFileSync(path.join(retained,'cleanup.json'),JSON.stringify({pids:children.map(child=>child.pid),retired},null,2)+'\n');}
  const writable=directory=>{fs.chmodSync(directory,0o700);for(const item of fs.readdirSync(directory,{withFileTypes:true}))if(item.isDirectory())writable(path.join(directory,item.name));};writable(root);fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50});
 });
 const retained=process.env.ANDROID_ART_WINDOW_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});
 const run=(command,args,env=process.env,capture=false)=>{const result=spawnSync(command,args,{env,encoding:'utf8',timeout:20000,maxBuffer:4<<20});if(capture&&retained){fs.writeFileSync(path.join(retained,'stdout.log'),result.stdout||'');fs.writeFileSync(path.join(retained,'stderr.log'),result.stderr||'');}assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,(result.stdout+result.stderr).slice(-16000));return result.stdout+result.stderr;};
 const supplier=componentSupplier(path.resolve(payload)),c=supplier.components,fixture=path.resolve('tests/fixtures/android-art'),classes=path.join(root,'classes'),dex=path.join(root,'dex');fs.mkdirSync(classes);fs.mkdirSync(dex);
 run(path.join(java,'bin/javac'),['--release','21','-cp',path.join(payload,'android-framework.jar'),'-d',classes,path.join(fixture,'ArtWindowBufferProbe.java')]);run(path.join(java,'bin/jar'),['cf',path.join(root,'probe.jar'),'-C',classes,'.']);
 run(path.join(java,'bin/java'),['-cp',r8,'com.android.tools.r8.D8','--min-api','36','--lib',path.join(payload,'android-framework.jar'),'--output',dex,path.join(root,'probe.jar')]);
 run(clang,['-shared','-fPIC','-O2','-Wall','-Wextra','-Werror','-Wl,--no-undefined',path.join(fixture,'ArtWindowBufferProbe.c'),'-landroid','-o',path.join(root,'probe.so')]);
 native=await require('./helpers/android-art-native-graphics').nativeGraphicsSession({payload,root,gles,overlays:[['ro','/data/local/tmp/window-buffers',root]],classpath:'/data/local/tmp/window-buffers/dex/classes.dex',extraEnvironment:{KL_ANGLE_BACKEND:process.env.ANDROID_ART_WINDOW_BACKEND||'metal',...(process.env.ANDROID_ART_WINDOW_VULKAN?{KL_MVK_DYLIB:path.resolve(process.env.ANDROID_ART_WINDOW_VULKAN)}:{})}});
 children.push(...native.children);const env=native.environment,artBase=native.artBase;
 try{
  const output=run(c.linuxRun,[...artBase,'/system/bin/app_process64','-Ximage:/nonexistent/boot.art','-Xnoimage-dex2oat','/system/bin','ArtWindowBufferProbe','/data/local/tmp/window-buffers/probe.so'],env,true);
  assert.match(output,/PASS original ART BufferQueue producer geometry, resize, queued pixels, independent read surface and dequeue cancellation/);
  if(env.KL_ANGLE_BACKEND==='vulkan')assert.match(output,/CONTEXT .*renderer=ANGLE \(Apple, Vulkan /);
  t.diagnostic(output.split('\n').filter(line=>line.startsWith('PASS ')||line.startsWith('CONTEXT ')).join('\n'));
 }finally{if(retained)for(const name of ['properties','binder','servicemanager','allocator'])fs.copyFileSync(path.join(root,name+'.log'),path.join(retained,name+'.log'));}
});
