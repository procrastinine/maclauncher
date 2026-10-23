const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
test('original Linux inode ownership imports lazily without repeated tree walks',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_ART_BOOTSTRAP:bootstrap,ANDROID_CLANG:clang}=process.env;
 if(process.platform!=='darwin'||![payload,runner,bootstrap,clang].every(Boolean))return t.skip('Requires the original Android runtime and changed storage components');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-imported-storage-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(exe,args,options={})=>{const result=spawnSync(exe,args,{encoding:'utf8',timeout:30000,...options});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);assert.doesNotMatch(result.stderr,/guest imported inode metadata failed/);return result.stdout;};
 const app=path.join(root,'app'),peer=path.join(root,'peer'),state=path.join(root,'state'),binary=path.join(root,'probe');
 for(const directory of ['nested','unseen-tree/deep','explicit-tree','bulk'])fs.mkdirSync(path.join(app,directory),{recursive:true,mode:0o755});fs.mkdirSync(peer,{mode:0o755});fs.mkdirSync(state);
 for(const [name,mode]of [['nested/existing',0o640],['unseen-link',0o600],['unseen-tree/deep/child',0o600],['explicit-tree/child',0o600]])fs.writeFileSync(path.join(app,name),'original',{mode});
 fs.writeFileSync(path.join(peer,'target'),'peer',{mode:0o644});fs.symlinkSync('/peer/target',path.join(app,'symlink'));
 const plain=path.join(root,'plain'),code=path.join(root,'code');fs.mkdirSync(plain);fs.writeFileSync(code,'immutable',{mode:0o444});fs.writeFileSync(path.join(plain,'file'),'ordinary');
 for(let index=0;index<4096;index++)fs.writeFileSync(path.join(app,'bulk',String(index)),'untouched');
 const absent=file=>assert.notEqual(spawnSync('/usr/bin/xattr',['-p','dev.aim.guest-inode',file]).status,0,'Unvisited descendants remain unmodified');
 const start=performance.now();for(let repeat=0;repeat<10;repeat++)run(bootstrap,['initialize','10001',app]);const elapsed=performance.now()-start;
 run(bootstrap,['initialize','10002',peer]);absent(path.join(app,'bulk/4095'));absent(path.join(app,'unseen-tree/deep/child'));
 const readOnly=path.join(root,'readonly');fs.mkdirSync(readOnly,{mode:0o555});run(bootstrap,['initialize','10003',readOnly]);
 assert.equal(fs.statSync(readOnly).mode&0o7777,0o555,'The original metadata writer restores a read-only imported root mode');
 fs.mkdirSync(path.join(app,'late/deep'),{recursive:true,mode:0o755});fs.writeFileSync(path.join(app,'late/deep/new'),'after declaration',{mode:0o600});
 run(bootstrap,['initialize','10001',app]);absent(path.join(app,'late/deep/new'));
 run(clang,['tests/fixtures/android-art-storage/imported.c','-o',binary]);
 const {componentSupplier}=require('./helpers/android-art-supplier'),supplier=componentSupplier(path.resolve(payload));
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const map=publishPathMap(state,'imported',prepareMountParents(layout({supplier,state})+`rw\t/app\t${app}\nrw\t/alias\t${app}\nrw\t/peer\t${peer}\nrw\t/plain\t${plain}\nro\t/code\t${code}\nro\t/system/bin/imported-proof\t${binary}\n`,path.join(root,'parents')));
 // Imported defaults stop at the actual mounted area. An inaccessible host
 // ancestor is irrelevant; immutable code cannot gain writable guest metadata.
 const policy=path.join(root,'sandbox.sb');fs.writeFileSync(policy,`(version 1)(allow default)(deny file-read-xattr (literal ${JSON.stringify(root)}))(deny file-write* (literal ${JSON.stringify(code)}))`);
 const output=run('/usr/bin/sandbox-exec',['-f',policy,runner,'--inherit-env','--path-map',map,'--no-cache','/system/bin/imported-proof'],{env:{...environment(supplier),TMPDIR:root}});
 assert.match(output,/PASS imported metadata, aliases/);absent(path.join(app,'bulk/4095'));
 absent(code);absent(path.join(plain,'file'));
 // A later initialization retains every explicit guest change.
 run(bootstrap,['initialize','10001',app]);
 const metadata=run('/usr/bin/xattr',['-px','dev.aim.guest-inode',path.join(app,'nested/existing')]).replace(/\s/g,'');
 const record=Buffer.from(metadata,'hex');assert.equal(record.readUInt32LE(8),10023);assert.equal(record.readUInt32LE(12),10024);assert.equal(record.readUInt32LE(16),0o644);
 t.diagnostic(`10 initializations over4096 untouched descendants: ${elapsed.toFixed(3)}ms, zero descendant guest-inode writes; ${output.trim()}`);
 const previous=process.env.ANDROID_ART_PREVIOUS_BOOTSTRAP;
 if(previous){
  run(previous,['initialize','10001',app]); // Record the old algorithm's first-use fields before measuring its repeated walk.
  const start=performance.now();for(let repeat=0;repeat<3;repeat++)run(previous,['initialize','10001',app]);
  t.diagnostic(`Previous repeated initialization: ${((performance.now()-start)/3).toFixed(3)}ms/launch; current ${ (elapsed/10).toFixed(3)}ms/launch including subprocess startup`);
 }
});

test('enrolled readonly code reuses tree ownership without visiting or writing descendants',async t=>{
 const {ANDROID_ART_PAYLOAD:payload,ANDROID_ART_LINUX_RUN:runner,ANDROID_ART_BOOTSTRAP:bootstrap,ANDROID_CLANG:clang}=process.env;
 if(process.platform!=='darwin'||![payload,runner,bootstrap,clang].every(Boolean))return t.skip('Requires the original Android runtime and changed storage components');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-code-storage-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(exe,args,options={})=>{const r=spawnSync(exe,args,{encoding:'utf8',timeout:30000,...options});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);assert.doesNotMatch(r.stderr,/guest imported inode metadata failed/);return r.stdout;};
 const code=path.join(root,'code'),nested=path.join(code,'nested'),standalone=path.join(root,'standalone'),standaloneExec=path.join(root,'standalone-exec'),plain=path.join(root,'undeclared'),app=path.join(root,'app'),peer=path.join(root,'peer'),secret=path.join(peer,'private/secret'),state=path.join(root,'state');
 for(const dir of [nested,path.join(code,'bulk'),plain,app,path.dirname(secret),state])fs.mkdirSync(dir,{recursive:true,mode:0o700});
 for(const name of ['nested/unseen','explicit','explicit-exec','explicit-owner-exec','partial','original','exec','owner-exec'])fs.writeFileSync(path.join(code,name),'original',{mode:name==='exec'?0o711:['owner-exec','explicit-exec','explicit-owner-exec'].includes(name)?0o700:0o600});
 for(const file of [standalone,path.join(plain,'file'),secret])fs.writeFileSync(file,'private',{mode:0o600});
 fs.writeFileSync(standaloneExec,'private executable',{mode:0o700});fs.writeFileSync(path.join(app,'private'),'private',{mode:0o600});fs.writeFileSync(path.join(app,'exec'),'private executable',{mode:0o700});
 fs.symlinkSync('/peer/private/secret',path.join(code,'private-link'));
 for(let i=0;i<4096;i++)fs.writeFileSync(path.join(code,'bulk',String(i)),'untouched',{mode:0o600});
 const record=(file,fields)=>{const bytes=Buffer.alloc(20);bytes.write('DAGI');bytes[4]=1;for(const [i,key]of ['uid','gid','mode'].entries())if(fields[key]!==undefined){bytes[5]|=1<<i;bytes.writeUInt32LE(fields[key],8+4*i);}run('/usr/bin/xattr',['-wx','dev.aim.guest-inode',bytes.toString('hex'),file]);};
 record(path.join(code,'explicit'),{uid:10023,gid:10024,mode:0o440});record(path.join(code,'explicit-exec'),{uid:0,gid:0,mode:0o600});record(path.join(code,'explicit-owner-exec'),{uid:0,gid:0,mode:0o744});record(path.join(code,'partial'),{uid:10023});
 const original=Buffer.alloc(20);original.write('DARI');original[4]=1;original.writeUInt32LE(10037,8);original.writeUInt32LE(10038,12);original.writeUInt32LE(0o440,16);
 run('/usr/bin/xattr',['-wx','dev.aim.android-inode',original.toString('hex'),path.join(code,'original')]);
 const unseen=path.join(code,'nested/unseen'),bulk=path.join(code,'bulk/4095'),identity=file=>{const s=fs.statSync(file,{bigint:true});return {ino:s.ino,ctime:s.ctimeNs,mode:s.mode};};
 const before=[identity(unseen),identity(bulk)];
 const absent=file=>assert.notEqual(spawnSync('/usr/bin/xattr',['-p','dev.aim.guest-inode',file]).status,0,'Unvisited code has no materialized guest inode');
 const started=performance.now();run(bootstrap,['initialize-package',code,standalone,standaloneExec]);const fileIdentity=identity(standalone),execIdentity=identity(standaloneExec);
 run(bootstrap,['initialize-package',code,standalone,standaloneExec]);const elapsed=performance.now()-started;
 assert.deepEqual(identity(standaloneExec),execIdentity);
 run(bootstrap,['initialize','10074',app]);run(bootstrap,['initialize','10075',peer]);
 assert.deepEqual([identity(unseen),identity(bulk)],before);assert.deepEqual(identity(standalone),fileIdentity);absent(unseen);absent(bulk);
 const late=path.join(code,'late/deep/file');fs.mkdirSync(path.dirname(late),{recursive:true,mode:0o700});fs.writeFileSync(late,'later code',{mode:0o600});absent(late);
 assert.equal(Number(fs.statSync(code).mode)&0o7777,0o700,'Physical host modes remain private');
 for(const file of [path.join(code,'owner-exec'),standaloneExec,app,path.join(app,'exec'),peer])assert.equal(fs.statSync(file).mode&0o7777,0o700,'Executable code and private app data keep their physical0700 modes');
 const binary=path.join(root,'probe');run(clang,['tests/fixtures/android-art-storage/code.c','-o',binary]);
 const supplier=require('./helpers/android-art-supplier').componentSupplier(path.resolve(payload));
 const {layout,prepareMountParents,publishPathMap,environment}=await import('../src/modules/android/art/layout.mjs');
 const map=publishPathMap(state,'code',prepareMountParents(layout({supplier,state})+`ro\t/code\t${code}\nro\t/code-alias\t${code}\nro\t/standalone\t${standalone}\nro\t/standalone-exec\t${standaloneExec}\nro\t/undeclared\t${plain}\nrw\t/app\t${app}\nrw\t/peer\t${peer}\nro\t/system/bin/code-proof\t${binary}\n`,path.join(root,'parents')));
 const policy=path.join(root,'sandbox.sb');fs.writeFileSync(policy,`(version 1)(allow default)(deny file-read-xattr (literal ${JSON.stringify(root)}))(deny file-write* (subpath ${JSON.stringify(code)}))(deny file-write* (literal ${JSON.stringify(standalone)}))(deny file-write* (literal ${JSON.stringify(standaloneExec)}))`);
 const output=run('/usr/bin/sandbox-exec',['-f',policy,runner,'--inherit-env','--path-map',map,'--no-cache','/system/bin/code-proof'],{env:{...environment(supplier),TMPDIR:root}});
 assert.match(output,/PASS declared readonly code/);assert.deepEqual([identity(unseen),identity(bulk)],before);absent(unseen);absent(bulk);absent(late);absent(path.join(code,'owner-exec'));
 assert.deepEqual(identity(standaloneExec),execIdentity);assert.equal(fs.statSync(path.join(code,'owner-exec')).mode&0o7777,0o700);
 t.diagnostic(`Two code initializations over 4096 untouched descendants: ${elapsed.toFixed(3)} ms; ${output.trim()}`);
});
