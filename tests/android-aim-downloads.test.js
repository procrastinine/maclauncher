const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DownloadManager}=require('../src/modules/shared/runtime/download-manager');
const Aim=require('../src/modules/android/providers/aim');
const {directoryForImage}=require('../src/modules/android/providers/aim/image-cache');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-aim-download-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const userDataDir=path.join(root,'profile'),runtime={root:path.join(root,'runtime'),bin:path.join(root,'runtime/bin'),manifest:{files:[]}};
  fs.mkdirSync(userDataDir);fs.mkdirSync(path.join(runtime.root,'image'),{recursive:true});
  const overlay='schema = 1\n';fs.writeFileSync(path.join(runtime.root,'image/overlay.toml'),overlay);
  runtime.manifest.files.push({path:'image/overlay.toml',sha256:sha(overlay)});
  const archive=Buffer.from('verified original image archive'),image={url:'https://example.invalid/system.zip',sha256:sha(archive),version:'fixture',licenseUrl:'https://example.invalid/license'};
  const history=[],downloads=new DownloadManager({progressThrottleMs:0,onChange:()=>history.push(downloads.list())});
  const context={userDataDir,downloads,confirmRuntimeInstall:async()=>{assert.equal(downloads.list().length,0);return true;}};
  const directory=directoryForImage(userDataDir,runtime,image);let transfers=0,preparations=0;
  const dependencies={image,downloadToFile:async(_url,file,{signal,onProgress})=>{
    signal?.throwIfAborted();transfers++;fs.writeFileSync(file,archive);onProgress({downloaded:archive.length,total:archive.length});
  },capture:async(_file,_args,{signal})=>{
    signal?.throwIfAborted();preparations++;const target=path.join(directory,'derived/root');fs.mkdirSync(target,{recursive:true});
    fs.writeFileSync(path.join(directory,'system.dmg'),'original image');fs.writeFileSync(path.join(target,'.identity'),'verified');return '';
  }};
  return {root,context,runtime,archive,image,directory,dependencies,downloads,history,get transfers(){return transfers;},get preparations(){return preparations;},options:{context,runtime}};
}

test('AIM image acquisition uses ordinary downloads through checksum/preparation and reuses the cached image',async t=>{
  const f=fixture(t),capture=f.dependencies.capture;
  f.dependencies.capture=async(...args)=>{
    const [task]=f.downloads.list();assert.equal(task.managerId,'android-aim-image');assert.equal(task.sectionId,'default');
    assert.equal(task.detail,'Preparing…');assert.equal(task.downloaded,f.archive.length);
    return capture(...args);
  };
  const first=await Aim.prepareSystem(f.options,f.dependencies);
  assert.equal(first.directory,f.directory);assert.equal(f.transfers,1);assert.deepEqual(f.downloads.list(),[]);
  assert.ok(f.history.some(rows=>rows.some(row=>row.detail==='Verifying…')));
  assert.ok(f.history.some(rows=>rows.some(row=>row.status==='done')));
  assert.equal(fs.existsSync(path.join(f.directory,'system.zip')),false);
  f.context.confirmRuntimeInstall=()=>assert.fail('Cached image needs no download consent');
  f.dependencies.downloadToFile=()=>assert.fail('Cached image needs no transfer');
  f.dependencies.capture=capture;
  const second=await Aim.prepareSystem(f.options,f.dependencies);
  assert.equal(second.image,first.image);assert.equal(f.transfers,1);assert.equal(f.preparations,2);assert.deepEqual(f.downloads.list(),[]);
});

test('AIM shared Cancel and launch cancellation stop the image task and remove its archive',async t=>{
  for(const from of ['downloads','launch'])await t.test(from,async t=>{
    const f=fixture(t),controller=new AbortController();f.context.signal=controller.signal;
    f.dependencies.downloadToFile=async(_url,file,{signal,onProgress})=>{
      fs.writeFileSync(file,f.archive);onProgress({downloaded:4,total:f.archive.length});
      if(from==='downloads')assert.equal(f.downloads.cancel(f.downloads.list()[0].id),true);else controller.abort();
      signal.throwIfAborted();
    };
    await assert.rejects(Aim.prepareSystem(f.options,f.dependencies),{name:'AbortError'});
    assert.deepEqual(f.downloads.list(),[]);assert.equal(f.preparations,0);
    assert.equal(fs.existsSync(path.join(f.directory,'system.zip')),false);
    assert.ok(f.history.some(rows=>rows.some(row=>row.status==='canceled')));
  });
});

test('AIM cancellation remains connected during preparation and checksum errors retire the task',async t=>{
  await t.test('preparation',async t=>{
    const f=fixture(t);f.dependencies.capture=async(_file,_args,{signal})=>{
      assert.equal(f.downloads.list()[0].detail,'Preparing…');
      f.downloads.cancel(f.downloads.list()[0].id);signal.throwIfAborted();
    };
    await assert.rejects(Aim.prepareSystem(f.options,f.dependencies),{name:'AbortError'});
    assert.deepEqual(f.downloads.list(),[]);assert.equal(fs.existsSync(path.join(f.directory,'system.zip')),false);
  });
  await t.test('checksum',async t=>{
    const f=fixture(t);f.dependencies.downloadToFile=async(_url,file)=>fs.writeFileSync(file,'incorrect');
    await assert.rejects(Aim.prepareSystem(f.options,f.dependencies),/checksum did not match/);
    assert.equal(f.preparations,0);assert.deepEqual(f.downloads.list(),[]);
    assert.ok(f.history.some(rows=>rows.some(row=>row.status==='error'&&/checksum/.test(row.error))));
    assert.equal(fs.existsSync(path.join(f.directory,'system.zip')),false);
  });
});
