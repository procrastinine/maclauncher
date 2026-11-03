const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {fileHash}=require('../src/modules/android/prepare');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
// Hold every observed stat field constant, including mtime and a whole-second
// ctime, while real file bytes change. No filesystem timing or sleeps involved.
function holdStat(t,file) {
  const lstat=fs.lstatSync.bind(fs),open=fs.promises.open.bind(fs.promises),original=lstat(file,{bigint:true});
  const stat=Object.assign(Object.create(Object.getPrototypeOf(original)),original,{ctimeNs:1000000000n,ctimeMs:1000n});
  const state={stat,reads:0,onReadEnd:null};
  t.mock.method(fs,'lstatSync',(...args)=>path.resolve(String(args[0]))===file?stat:lstat(...args));
  t.mock.method(fs.promises,'open',async(...args)=>{
    const handle=await open(...args);
    if(path.resolve(String(args[0]))===file){
      handle.stat=async()=>stat;
      const create=handle.createReadStream.bind(handle);
      handle.createReadStream=(...options)=>{state.reads++;const stream=create(...options);stream.once('end',()=>state.onReadEnd?.());return stream;};
    }
    return handle;
  });
  return state;
}

test('Coarse Android timestamps recheck memory and persisted digests against the actual bytes',async t=>{
  const Digests=require('../src/modules/android/preparation-digests');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-coarse-cache-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'input');fs.writeFileSync(file,'original');const held=holdStat(t,file),cache=Digests.open(root);
  assert.equal(await fileHash(file,undefined,cache),digest('original'));cache.save();
  const persisted=Digests.open(root);assert.equal(persisted.get(file).sha256,digest('original'));
  assert.equal(Digests.reusable(held.stat,persisted.get(file)),false);
  assert.equal(await fileHash(file,undefined,persisted),digest('original'));
  assert.equal(held.reads,4,'Even a warm coarse stamp requires two bounded byte passes');
  fs.writeFileSync(file,'modified');fs.utimesSync(file,held.stat.atime,held.stat.mtime);
  assert.equal(await fileHash(file,undefined,persisted),digest('modified'));persisted.save();
  assert.equal(held.reads,6);assert.equal(Digests.open(root).get(file).sha256,digest('modified'));
});

test('Coarse Android timestamps detect an equal-size mutation during a read and never cache it',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-coarse-read-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'input');fs.writeFileSync(file,'original');const held=holdStat(t,file);
  held.onReadEnd=()=>{held.onReadEnd=null;fs.writeFileSync(file,'modified');fs.utimesSync(file,held.stat.atime,held.stat.mtime);};
  await assert.rejects(fileHash(file),error=>{
    assert.equal(error.code,'ANDROID_PREPARATION_INPUT_CHANGED');
    assert.equal(error.identityBefore,error.identityDescriptorAfter);assert.equal(error.identityBefore,error.identityPathAfter);return true;
  });
  assert.equal(await fileHash(file),digest('modified'));assert.equal(held.reads,4);
});

test('Coarse Android source timestamps cannot hide changes after the staged APK was copied',async t=>{
  const {copyOriginal}=require('../src/modules/android/prepare');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-coarse-copy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'original.apk'),output=path.join(root,'base.apk');fs.writeFileSync(source,'original package');
  const held=holdStat(t,source),open=fs.promises.open.bind(fs.promises);let changed=false;
  t.mock.method(fs.promises,'open',async(...args)=>{
    const handle=await open(...args);
    if(String(args[0]).includes(path.sep+'.copy-')){
      const create=handle.createReadStream.bind(handle);
      handle.createReadStream=(...options)=>{const stream=create(...options);stream.once('end',()=>{
        if(!changed){changed=true;fs.writeFileSync(source,'modified package');fs.utimesSync(source,held.stat.atime,held.stat.mtime);}
      });return stream;};
    }return handle;
  });
  await assert.rejects(copyOriginal(source,output,digest('original package')),/changed during preparation/);
  assert.equal(changed,true);assert.deepEqual(fs.readdirSync(root),['original.apk']);
  await copyOriginal(source,output,digest('modified package'));
  assert.equal(fs.readFileSync(output,'utf8'),'modified package');
});

test('Installed APK copies preserve independent bytes, private modes and exclusive publication',async t=>{
  const {copyOriginal}=require('../src/modules/android/prepare');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-package-copy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'original.apk'),installed=path.join(root,'base.apk');
  fs.writeFileSync(source,'original package',{mode:0o644});
  await copyOriginal(source,installed,digest('original package'));
  assert.equal(fs.statSync(installed).mode&0o777,0o600);
  assert.notEqual(fs.statSync(source).ino,fs.statSync(installed).ino,'Installed code never shares a writable inode with its import');
  fs.writeFileSync(source,'modified package');assert.equal(fs.readFileSync(installed,'utf8'),'original package');
  await assert.rejects(copyOriginal(source,installed,digest('modified package')),error=>error.code==='EEXIST');
  assert.equal(fs.readFileSync(installed,'utf8'),'original package');
  const alias=path.join(root,'alias.apk');fs.symlinkSync(source,alias);
  await assert.rejects(copyOriginal(alias,path.join(root,'alias-copy.apk'),digest('modified package')));
  assert.equal(fs.existsSync(path.join(root,'alias-copy.apk')),false);
  await assert.rejects(copyOriginal(source,path.join(root,'changed.apk'),digest('other package')),/changed during preparation/);
  assert.equal(fs.existsSync(path.join(root,'changed.apk')),false,'a failed full hash is never published');
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(copyOriginal(source,path.join(root,'cancelled.apk'),digest('modified package'),cancelled.signal),/abort/i);
  assert.equal(fs.existsSync(path.join(root,'cancelled.apk')),false);
});

test('Original APK source identity is pinned through staged validation',async t=>{
  const {copyOriginal}=require('../src/modules/android/prepare');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-package-source-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'original.apk'),output=path.join(root,'base.apk'),open=fs.promises.open.bind(fs.promises);
  fs.writeFileSync(source,'original package');let changed=false;
  t.mock.method(fs.promises,'open',async(...args)=>{const handle=await open(...args);
    if(String(args[0]).includes(path.sep+'.copy-')){const create=handle.createReadStream.bind(handle);handle.createReadStream=(...options)=>{
      const stream=create(...options);if(!changed){changed=true;fs.writeFileSync(source,'modified package');}return stream;
    };}return handle;
  });
  await assert.rejects(copyOriginal(source,output,digest('original package')),/changed during preparation/);
  assert.equal(changed,true);assert.equal(fs.existsSync(output),false);
  assert.deepEqual(fs.readdirSync(root),['original.apk']);
});

test('Installed generation copies retain verified bytes, native modes and existing readers',async t=>{
  const Prep=require('../src/modules/android/prepare'),{INSPECTION_VERSION}=require('../src/modules/android/binary-manifest');
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-installed-copy-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const key='a'.repeat(64),root=path.join(directory,key),native='input/lib/arm64-v8a/libexample.so';
  fs.mkdirSync(path.dirname(path.join(root,native)),{recursive:true});
  const entries=[['source.apk','original package',0o600],['converted.jar','converted code',0o600],[native,'native code',0o700]];
  for(const [name,bytes,mode]of entries)fs.writeFileSync(path.join(root,name),bytes,{mode});
  const receipt={schemaVersion:2,key,sourceName:'source.apk',nativeInstallVersion:1,
    apkSha256:digest('original package'),convertedSha256:digest('converted code'),
    files:[{name:'lib/arm64-v8a/libexample.so',sha256:digest('native code'),size:11}],
    metadata:{manifestInspectionVersion:INSPECTION_VERSION,debuggable:false,hasCode:true,
      applicationMetadataInspected:true,applicationIconInspected:true,applicationComponentsInspected:true,nativeAbi:'arm64-v8a'}};
  fs.writeFileSync(path.join(root,'prepared.json'),JSON.stringify(receipt));
  const installed=await Prep.installedGeneration(directory,{root,receipt});assert.notEqual(installed.root,root);
  const base=require('../src/modules/android/package-set').installedName(null);
  for(const [name,bytes,mode]of entries){const output=path.join(installed.root,name==='source.apk'?base:name);
    assert.equal(fs.readFileSync(output,'utf8'),bytes);assert.equal(fs.statSync(output).mode&0o777,mode);
    assert.notEqual(fs.statSync(output).ino,fs.statSync(path.join(root,name)).ino);
  }
  assert.ok(await Prep.existingCache(installed.root,key));
  fs.writeFileSync(path.join(installed.root,base),'independent edit');
  assert.equal(fs.readFileSync(path.join(root,'source.apk'),'utf8'),'original package');
  assert.deepEqual(fs.readdirSync(directory).filter(x=>x.startsWith('.prepare-')),[]);
});

test('Android preparation reuses unchanged bytes and invalidates edits, replacements and in-flight mutations',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-hash-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'input'),open=fs.promises.open.bind(fs.promises);let reads=0,onRead=null;
  t.mock.method(fs.promises,'open',async(...args)=>{const handle=await open(...args),create=handle.createReadStream.bind(handle);handle.createReadStream=(...options)=>{reads++;const stream=create(...options);onRead?.();return stream;};return handle;});
  fs.writeFileSync(file,'original');assert.equal(await fileHash(file),digest('original'));assert.equal(reads,1);
  assert.equal(await fileHash(file),digest('original'));assert.equal(reads,1,'an unchanged inode requires metadata only');
  const before=fs.statSync(file);fs.writeFileSync(file,'modified');fs.utimesSync(file,before.atime,before.mtime);
  assert.equal(await fileHash(file),digest('modified'));assert.equal(reads,2,'ctime invalidates same-size edits even with restored mtime');
  fs.writeFileSync(path.join(root,'replacement'),'replaced');fs.utimesSync(path.join(root,'replacement'),before.atime,before.mtime);fs.renameSync(path.join(root,'replacement'),file);
  assert.equal(await fileHash(file),digest('replaced'));assert.equal(reads,3,'replacement inode cannot reuse the old digest');
  fs.writeFileSync(file,'changing');onRead=()=>fs.writeFileSync(file,'mid-read');
  await assert.rejects(fileHash(file),error=>{
    assert.match(error.message,/changed while being read/);assert.equal(error.code,'ANDROID_PREPARATION_INPUT_CHANGED');assert.equal(error.path,file);
    assert.notEqual(error.identityBefore,error.identityDescriptorAfter);assert.equal(error.identityPathAfter,error.identityDescriptorAfter);return true;
  });onRead=null;
  assert.equal(await fileHash(file),digest('mid-read'));assert.equal(reads,5,'a failed read never installs a cached digest');
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(fileHash(file,cancelled.signal),/abort/i);assert.equal(reads,5);
  const alias=path.join(root,'alias');fs.symlinkSync(file,alias);await assert.rejects(fileHash(alias),/regular files/);
});

test('Independent preparation workers reuse digests while changed bytes and damaged indices are rechecked',async t=>{
  const {execFileSync}=require('node:child_process');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-persistent-hash-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'input'),index=path.join(root,'.preparation-digests.json');
  const probe=()=>JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'fixtures/android-prepared-cache/digests.cjs'),root,file],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  fs.writeFileSync(file,'original');assert.deepEqual(probe(),{sha256:digest('original'),reads:1});
  const unchanged=fs.statSync(index,{bigint:true});
  assert.deepEqual(probe(),{sha256:digest('original'),reads:0});
  assert.equal(fs.statSync(index,{bigint:true}).mtimeNs,unchanged.mtimeNs,'unchanged index is not rewritten');
  const before=fs.statSync(file);fs.writeFileSync(file,'modified');fs.utimesSync(file,before.atime,before.mtime);
  assert.deepEqual(probe(),{sha256:digest('modified'),reads:1},'same-size edits with restored mtime still rehash');
  fs.writeFileSync(path.join(root,'replacement'),'replaced');fs.utimesSync(path.join(root,'replacement'),before.atime,before.mtime);
  fs.renameSync(path.join(root,'replacement'),file);
  assert.deepEqual(probe(),{sha256:digest('replaced'),reads:1},'inode replacement invalidates reuse');
  fs.writeFileSync(index,'broken');assert.deepEqual(probe(),{sha256:digest('replaced'),reads:1});
  assert.deepEqual(probe(),{sha256:digest('replaced'),reads:0});
  fs.unlinkSync(file);assert.throws(probe,/ENOENT/);
});
