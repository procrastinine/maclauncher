const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java'),{namespace}=require('../src/modules/android/storage-namespace');
const {removeTemporaryTree}=require('./helpers/temporary-tree');

test('ART expands the shared storage policy for physical and canonical private filenames',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-storage-aliases-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const data=path.join(root,'data'),pkg='org.example.namespace',code=path.join(root,'code');
 fs.mkdirSync(path.join(data,'obb'),{recursive:true});fs.writeFileSync(path.join(data,'obb/retained.obb'),'retained expansion bytes');
 const {applicationLayout,guestDataDirectory}=await import('../src/modules/android/art/layout.mjs');
 const rows=applicationLayout({packageName:pkg,dataRoot:data,sourceApks:[path.join(code,'base.apk')],nativeRoot:path.join(code,'lib/arm64-v8a')}).trim().split('\n').map(row=>row.split('\t'));
 const resolve=guest=>{const row=rows.filter(([,prefix])=>guest===prefix||guest.startsWith(prefix+'/')).sort((a,b)=>b[1].length-a[1].length)[0];assert.ok(row,guest);return path.join(row[2],path.posix.relative(row[1],guest));};
 for(const sourceData of [data,guestDataDirectory(pkg)]){
  for(const alias of namespace({packageName:pkg,dataRoot:sourceData,partitionsRoot:'/'}).mappings){
   const relative=path.relative(sourceData,alias.target);
   if(alias.nativeMount===false||relative==='..'||relative.startsWith('../')||path.isAbsolute(relative))continue;
   assert.equal(resolve(alias.android),path.join(data,relative),alias.android);
  }
  const file=path.posix.join(sourceData,'files/Android/obb',pkg,'retained.obb');
  assert.equal(fs.readFileSync(resolve(file),'utf8'),'retained expansion bytes');
 }
 for(const prefix of ['/data/user/0/'+pkg+'/files','/data/data/'+pkg+'/files']){
  assert.equal(resolve(prefix+'/Android/data/'+pkg+'/files/retained.txt'),path.join(data,'files/retained.txt'));
  assert.equal(resolve(prefix+'/Android/data/'+pkg+'/cache/retained.txt'),path.join(data,'cache/retained.txt'));
  assert.equal(resolve(prefix+'/Android/obb/'+pkg+'/retained.obb'),path.join(data,'obb/retained.obb'));
  assert.equal(resolve(prefix+'/ordinary/Android/data/'+pkg+'/files/retained.txt'),path.join(data,'files/ordinary/Android/data/'+pkg+'/files/retained.txt'));
  assert.equal(resolve(prefix+'/Android/data/other.package/files/retained.txt'),path.join(data,'files/Android/data/other.package/files/retained.txt'));
 }
 assert.equal(resolve('/data/user_de/0/'+pkg+'/files/Android/data/'+pkg+'/files/retained.txt'),path.join(data,'device_protected/files/Android/data/'+pkg+'/files/retained.txt'));
 assert.equal(rows.some(([,prefix])=>prefix.startsWith('/data/user/0/other.package/')),false,'No other application private root is mounted');
 assert.equal(new Set(rows.map(([,guest])=>guest)).size,rows.length,'Each path has one owner');
 for(const [mode,,target]of rows.filter(([mode])=>mode==='rw'))assert.ok(target===data||target.startsWith(data+path.sep));
});

test('original ART filesystem reads retained expansion bytes through canonical app paths',async t=>{
 const payload=process.env.ANDROID_ART_PAYLOAD,runner=process.env.ANDROID_ART_LINUX_RUN;
 if(process.platform!=='darwin'||!payload||!runner)return t.skip('Requires the Android image and adapted runner');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-storage-native-')));t.after(()=>removeTemporaryTree(root));
 const data=path.join(root,'data'),code=path.join(root,'code'),state=path.join(root,'state'),pkg='org.example.namespace';
 fs.mkdirSync(path.join(data,'obb'),{recursive:true});fs.mkdirSync(path.join(data,'files'),{recursive:true});fs.mkdirSync(path.join(code,'lib/arm64-v8a'),{recursive:true});fs.mkdirSync(state);
 fs.writeFileSync(path.join(code,'base.apk'),'fixture code input');fs.writeFileSync(path.join(data,'obb/retained.obb'),'retained expansion bytes\n');
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));
 const {layout,applicationLayout,prepareMountParents,publishPathMap,environment,guestDataDirectory}=await import('../src/modules/android/art/layout.mjs');
 const map=publishPathMap(state,'storage',prepareMountParents(layout({supplier,state})+applicationLayout({packageName:pkg,dataRoot:data,sourceApks:[path.join(code,'base.apk')],nativeRoot:path.join(code,'lib/arm64-v8a')}),path.join(root,'mounts')));
 const files=[guestDataDirectory(pkg)+'/files/Android/obb/'+pkg+'/retained.obb','/sdcard/Android/obb/'+pkg+'/retained.obb',path.join(data,'files/Android/obb',pkg,'retained.obb'),'/data/data/'+pkg+'/files/Android/obb/'+pkg+'/retained.obb'];
 const env={...environment(supplier),...(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment,DYLD_FRAMEWORK_PATH:path.resolve(payload,'native')};
 const result=spawnSync(runner,['--inherit-env','--path-map',map,'--cache',path.join(root,'native-cache'),'--host-module',supplier.components.hostLibrary,'/system/bin/toybox','cat',...files],{encoding:'utf8',env,timeout:20000,maxBuffer:1<<20});
 assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(result.signal,null,result.stderr);
 assert.equal(result.stdout,'retained expansion bytes\n'.repeat(files.length));
});

test('JVM Java and ART native paths share persistent app storage and original partition locations',async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(!runtime||!home)return t.skip('Requires built Android classes and Java21');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-storage-namespace-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const data=path.join(root,'data'),output=path.join(root,'classes');for(const name of ['files','cache','obb'])fs.mkdirSync(path.join(data,name),{recursive:true});fs.mkdirSync(output);
 fs.writeFileSync(path.join(data,'obb/retained.obb'),'retained expansion bytes');
 const cp=[output,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
 const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:15000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,'src/modules/android/native/java/maclauncher/android/framework/HostFilesystem.java','tests/fixtures/android-sandbox/StorageNamespaceProbe.java']);
 fs.copyFileSync('src/modules/android/native/resources/storage-namespace.json',path.join(output,'maclauncher/android/framework/storage-namespace.json'));
 for(const mode of ['jvm','art']){
  const expected=namespace({packageName:'org.example.namespace',dataRoot:data,partitionsRoot:mode==='art'?'/':path.resolve(runtime,'android-root')});
  const file=path.join(root,mode+'.json');fs.writeFileSync(file,JSON.stringify(expected));
  assert.match(run(path.join(home,'bin/java'),['-cp',cp,'maclauncher.android.framework.StorageNamespaceProbe',mode,path.resolve(runtime),data,file]),new RegExp('PASS common storage namespace '+mode));
 }
 const {applicationLayout}=await import('../src/modules/android/art/layout.mjs');
 const mapping=applicationLayout({packageName:'org.example.namespace',dataRoot:data,sourceApks:[path.join(root,'code/base.apk')],nativeRoot:path.join(root,'code/lib/arm64-v8a')}).trim().split('\n').map(line=>line.split('\t'));
 function resolve(guest){const matches=mapping.filter(([,prefix])=>guest===prefix||guest.startsWith(prefix+'/')).sort((a,b)=>b[1].length-a[1].length);assert.ok(matches.length);return path.join(matches[0][2],path.posix.relative(matches[0][1],guest));}
 for(const prefix of ['/sdcard','/mnt/sdcard','/storage/emulated/0','/storage/self/primary']){
  assert.equal(fs.readFileSync(resolve(prefix+'/Android/obb/org.example.namespace/retained.obb'),'utf8'),'retained expansion bytes');
  assert.equal(resolve(prefix+'/Android/data/org.example.namespace/files'),path.join(data,'files'));
  assert.equal(resolve(prefix+'/Android/data/org.example.namespace/cache'),path.join(data,'cache'));
 }
 assert.equal(resolve('/data/user_de/0/org.example.namespace'),path.join(data,'device_protected'));
 assert.equal(resolve(path.join(data,'files/retained-path')),path.join(data,'files/retained-path'),'App-private absolute file names survive an execution-engine change');
 assert.equal(mapping.some(([,guest])=>guest==='/data'),false,'Original Android session keeps its own /data root');
 for(const [mode,,target]of mapping.filter(([mode])=>mode==='rw'))assert.ok(target===data||target.startsWith(data+path.sep),'Every writable alias stays inside this bottle');
 assert.throws(()=>namespace({packageName:'../other',dataRoot:data,partitionsRoot:'/'}),/package/);
});

test('unmodified JDK File and stream operations share expansion and virtual process files',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires built Android classes and Java21');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-jdk-storage-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const data=path.join(root,'data'),classes=path.join(root,'classes'),pkg='org.example.namespace';
 for(const name of ['files','cache','obb'])fs.mkdirSync(path.join(data,name),{recursive:true});fs.mkdirSync(classes);
 fs.writeFileSync(path.join(data,'obb','main.12.'+pkg+'.obb'),'original expansion bytes é 🐈');
 const cp=[classes,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
 const temporary=path.join(data,'cache','proc-é-🐈');fs.mkdirSync(temporary);
 const ids=path.join(root,'ids');fs.mkdirSync(ids,{mode:0o700});
 function run(binary,args){const result=spawnSync(path.join(home,'bin',binary),args,{encoding:'utf8',timeout:15000,env:{...process.env,TMPDIR:temporary,KL_ANDROID_ID_DIRECTORY:ids}});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}
 run('javac',['--release','21','-cp',cp,'-d',classes,'tests/fixtures/android-sandbox/JvmFileNamespaceProbe.java']);
 assert.match(run('java',['-Xcheck:jni','-cp',cp,'maclauncher.android.framework.JvmFileNamespaceProbe',path.resolve(runtime),data,process.env.ANDROID_JVM_FILESYSTEM_LIBRARY||path.resolve(runtime,'native/libklepton-jvm.dylib')]),/PASS actual JDK File metadata, directories, streams and canonical expansion ownership/);
});
