const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');

test('relocated ART supplier starts its original sibling terminal owner',{timeout:120000},async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_ART_PTY_HOLDER:holder,ANDROID_AIM_SOURCE:source,ANDROID_CLANG:clang}=process.env;
 if(process.platform!=='darwin'||process.arch!=='arm64'||![payload,runner,holder,source,clang].every(Boolean))return t.skip('Requires Apple Silicon, complete ART supplier, matching Linux components, original AIM source and Android Clang');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-art-pty-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const retained=process.env.ANDROID_PTY_OUTPUT;if(retained)fs.mkdirSync(retained,{recursive:true});
 const run=(program,args,options={})=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:30000,maxBuffer:4<<20,...options});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);return result;};
 const base=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));
 const inputs={...base.components,linuxRun:path.resolve(runner),ptyHolder:path.resolve(holder)};
 const assembled=path.join(root,'bundle'),moved=path.join(root,'relocated supplier');
 fs.cpSync(path.resolve(payload),assembled,{recursive:true,mode:fs.constants.COPYFILE_FICLONE,verbatimSymlinks:true,filter:file=>file!==path.resolve(payload,'art')});
 const {assembleArtSupplier}=await import('../src/modules/android/art/build.mjs');
 assembleArtSupplier({output:path.join(assembled,'art'),inputs,bootClasspath:base.bootClasspath,sourceVersion:'terminal-relocation'});
 fs.renameSync(assembled,moved);assert.ok(!fs.existsSync(assembled));
 const supplier=require('../src/modules/android/art/runtime').resolve({root:moved,profile:{artExecutionVersion:1}}),c=supplier.components;
 assert.equal(path.dirname(c.linuxRun),path.dirname(c.ptyHolder));
 assert.equal(path.basename(c.ptyHolder),'aim-pty-holder');
 const graph=fs.readFileSync(path.resolve(source,'crates/aim-build/src/cargo.rs'),'utf8');
 const node=graph.match(/if\s+target\.name\s*==\s*"linux-run"\s*\{([^}]+)\}/);
 assert.ok(node,'Original AIM Linux runner dependency declaration changed');
 const siblings=[...node[1].matchAll(/Dep::order_only\("host\/([^"/]+)"\)/g)].map(match=>match[1]);
 assert.ok(siblings.length,'Original Linux runner has no declared native sibling');
 for(const sibling of siblings){
  const file=path.join(path.dirname(c.linuxRun),sibling);
  assert.ok(Object.values(c).includes(file),'Original runner dependency is missing from the relocated manifest: '+sibling);
  assert.ok(fs.statSync(file).isFile());
 }
 const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 assert.equal(sha(c.linuxRun),sha(runner));assert.equal(sha(c.ptyHolder),sha(holder));
 assert.equal(run('codesign',['--verify','--strict',c.ptyHolder]).status,0);
 const binary=path.join(root,'t_pty'),built=run(clang,['-O1','-D_GNU_SOURCE','-Wall','-Werror','-o',binary,path.resolve(source,'crates/aim-linux-abi/tests/ndk/t_pty.c')]);assert.equal(built.status,0,built.stdout+built.stderr);
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const results=[];
 const execute=(name,args)=>{
  const state=path.join(root,name);fs.mkdirSync(state,{mode:0o700});
  const map=publishPathMap(state,'pty',prepareMountParents(layout({supplier,state})+'ro\t/data/local/tmp/t_pty\t'+binary+'\n',path.join(root,name+'-mounts')));
  assert.ok(!fs.readFileSync(map,'utf8').split('\n').some(row=>row.split('\t')[2]===root),'Private process metadata must stay outside guest mounts');
  const result=run(c.linuxRun,['--inherit-env','--host-module',c.hostLibrary,'--path-map',map,'--no-cache','/data/local/tmp/t_pty',...args],{env:{...process.env,...environment(supplier)}});
  if(retained){fs.writeFileSync(path.join(retained,name+'.stdout.log'),result.stdout);fs.writeFileSync(path.join(retained,name+'.stderr.log'),result.stderr);}
  results.push({name,status:result.status,stdout:result.stdout});return result;
 };
 const absent=c.ptyHolder+'.unavailable';fs.renameSync(c.ptyHolder,absent);
 try{const missing=execute('missing-helper',['--allocate-close']);assert.notEqual(missing.status,0,missing.stdout+missing.stderr);assert.match(missing.stdout,/master >= 0/);}finally{fs.renameSync(absent,c.ptyHolder);}
 for(const [name,args]of [['allocate-close',['--allocate-close']],['original',[]]]){const result=execute(name,args);assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS/);}
 if(retained)fs.writeFileSync(path.join(retained,'result.json'),JSON.stringify({manifest:supplier.manifest,originalDependencyDeclaration:'crates/aim-build/src/cargo.rs',siblings,linuxRunSha256:sha(c.linuxRun),ptyHolderSha256:sha(c.ptyHolder),results},null,2)+'\n');
});
