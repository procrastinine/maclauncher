const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('source preparation retains optional stack fixtures without requiring them in source distributions',async t=>{
 const checkout=path.resolve('src/external/aim-custom');
 if(!fs.existsSync(checkout))return t.skip('Requires the pinned original AIM source');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-stack-source-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=path.resolve(process.env.ANDROID_ART_SOURCE||'src/modules/android/art'),fixture=path.join(source,'native/initial-stack-tests.rs');
 const revision=JSON.parse(fs.readFileSync(path.join(source,'supplier.json'))).sources.aim.commit;
 const originals=new Map(['sys/arena.rs','sys/mod.rs','loader.rs'].map(name=>{
  const r=spawnSync('git',['-C',checkout,'show',revision+':crates/aim-linux-abi/src/'+name],{maxBuffer:2<<20});
  assert.ifError(r.error);assert.equal(r.status,0,String(r.stderr));return[name,r.stdout];
 }));
 for(const present of[true,false]){
  const selected=path.join(root,String(present)),module=path.join(selected,'art/stack-layout-source.mjs'),helper=path.join(selected,'native/upstream/source-files.mjs'),aim=path.join(selected,'aim');
  fs.mkdirSync(path.dirname(module),{recursive:true});fs.copyFileSync(path.join(source,'stack-layout-source.mjs'),module);
  fs.mkdirSync(path.dirname(helper),{recursive:true});fs.copyFileSync(path.resolve('src/modules/android/native/upstream/source-files.mjs'),helper);
  if(present){fs.mkdirSync(path.join(selected,'art/native'));fs.copyFileSync(fixture,path.join(selected,'art/native/initial-stack-tests.rs'));}
  for(const[name,bytes]of originals){const file=path.join(aim,'crates/aim-linux-abi/src',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}
  (await import(require('node:url').pathToFileURL(module).href)).prepareInitialStackLayout(aim);
  const target=path.join(aim,'crates/aim-linux-abi/src'),copied=path.join(target,'sys/initial-stack-tests.rs');
  assert.equal(fs.existsSync(copied),present);assert.equal(fs.readFileSync(path.join(target,'sys/mod.rs'),'utf8').includes('mod initial_stack_tests;'),present);
  if(present)assert.deepEqual(fs.readFileSync(copied),fs.readFileSync(fixture));
  assert.match(fs.readFileSync(path.join(target,'loader.rs'),'utf8'),/map_guest_stack\(STACK_SIZE/);
  assert.match(fs.readFileSync(path.join(target,'sys/arena.rs'),'utf8'),/pub fn map_stack/);
 }
});
test('original Bionic stack layout preserves guard, auxv, fork/exec and original Android10 map reparsing',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_CLANG:clang}=process.env;
 if(process.platform!=='darwin'||![payload,runner,clang].every(Boolean))return t.skip('Requires the original Android image, adapted runner and NDK Clang');
 const retain=process.env.ANDROID_THREAD_TEST_OUTPUT,root=fs.mkdtempSync(path.join(retain?path.resolve(retain):os.tmpdir(),'android-stack-layout-'));
 if(!retain)t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(program,args,options={})=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:20000,maxBuffer:6<<20,...options});assert.ifError(r.error);return r;};
 const pass=(program,args,options)=>{const r=run(program,args,options);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload)),c=supplier.components;
 if(process.env.ANDROID_ART_HOST_LIBRARY)c.hostLibrary=path.resolve(process.env.ANDROID_ART_HOST_LIBRARY);
 const source=path.resolve('tests/fixtures/android-art-stack'),guest=path.join(root,'stack-layout'),reparse=path.join(root,'maps-reparse');
 pass(clang,['-O2','-std=c11','-Wall','-Wextra','-Werror',source+'/layout.c','-o',guest]);
 pass('clang++',['-O0','-std=c++17','-Wall','-Wextra','-Werror',source+'/maps-reparse-android10.cpp','-o',reparse]);
 const {layout,environment,prepareMountParents,publishPathMap}=await import('../src/modules/android/art/layout.mjs'),state=path.join(root,'state');fs.mkdirSync(state);
 const map=publishPathMap(state,'stack',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/stack-layout\t'+guest+'\n',path.join(root,'mounts')));
 const env={...environment(supplier),...(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment,DYLD_FRAMEWORK_PATH:path.resolve(payload,'native')};
 const args=['--inherit-env','--path-map',map,'--no-cache','--host-module',c.hostLibrary];
 pass(runner,[...args,'/apex/com.android.runtime/bin/linkerconfig','--target','/linkerconfig'],{env});
 const regions=(output,phase)=>{
  const section=new RegExp('^MAPS_'+phase+'\\n([\\s\\S]*?)^END_MAPS_'+phase+'\\n','m').exec(output)?.[1];assert.ok(section,'Original proc maps snapshot '+phase);
  return section.trim().split('\n').map(line=>{const m=/^([0-9a-f]+)-([0-9a-f]+) ([-rwxps]{4}) [0-9a-f]+ [0-9a-f]+:[0-9a-f]+ \d+\s*(.*)$/.exec(line);assert.ok(m,line);const flags=(m[3][0]==='r'?1:0)|(m[3][1]==='w'?2:0)|(m[3][2]==='x'?4:0);return m[1]+' '+m[2]+' '+flags.toString(16)+' '+m[4];}).join('\n')+'\n';
 };
 const check=(selected,label)=>{
  const output=pass(selected,[...args,'/data/local/tmp/stack-layout'],{env});fs.writeFileSync(root+'/'+label+'.log',output);
  const before=root+'/'+label+'-before.maps',after=root+'/'+label+'-after.maps';fs.writeFileSync(before,regions(output,'BEFORE'));fs.writeFileSync(after,regions(output,'AFTER'));
  const result=run(reparse,[before,after]);fs.writeFileSync(root+'/'+label+'-reparse.json',JSON.stringify({status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr},null,2)+'\n');return{output,result};
 };
 if(process.env.ANDROID_ART_OLD_LINUX_RUN){const old=check(process.env.ANDROID_ART_OLD_LINUX_RUN,'old');assert.equal(old.result.signal,'SIGSEGV','Original Android10 merger must expose its prior-end bug on the old first-fit layout');}
 const {output,result}=check(runner,'new');assert.equal(result.signal,null,result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/PASS original Android10 Reparse on original Bionic maps/);
 const top=0x80000000000n,low=top-8n*1024n*1024n;
 for(const marker of ['STACK','CHILD_STACK']){const value=BigInt('0x'+new RegExp('(?:^|\\n)'+marker+' ([0-9a-f]+)').exec(output)?.[1]);assert.ok(value>low&&value<top,marker+' in original architecture stack window');}
 assert.match(output,/GUARD 1/);assert.match(output,/PASS original Bionic fork\/exec stack and auxv/);assert.match(output,/PASS original Bionic initial stack, mappings, auxv and child retirement/);
 t.diagnostic('Evidence '+root);
});
