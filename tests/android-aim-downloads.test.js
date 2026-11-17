const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DownloadManager}=require('../src/modules/shared/runtime/download-manager');
const Transport=require('../src/modules/shared/runtime/upstream-transport');
const Aim=require('../src/modules/android/providers/aim');
const {directoryForImage}=require('../src/modules/android/providers/aim/image-cache');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-aim-download-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const userDataDir=path.join(root,'profile'),runtime={root:path.join(root,'runtime'),bin:path.join(root,'runtime/bin'),manifest:{files:[]}};
  fs.mkdirSync(userDataDir);fs.mkdirSync(path.join(runtime.root,'image'),{recursive:true});
  const overlay='schema = 1\n';fs.writeFileSync(path.join(runtime.root,'image/overlay.toml'),overlay);
  runtime.manifest.files.push({path:'image/overlay.toml',sha256:sha(overlay)});
  const archive=Buffer.from('verified original image archive'),image={url:'https://example.invalid/system.zip',sha256:sha(archive),size:archive.length,version:'fixture',licenseUrl:'https://example.invalid/license'};
  const history=[],downloads=new DownloadManager({progressThrottleMs:0,onChange:()=>history.push(downloads.list())});
  const context={userDataDir,downloads,confirmRuntimeInstall:async()=>{assert.equal(downloads.list().length,0);return true;}};
  const directory=directoryForImage(userDataDir,runtime,image);let transfers=0,preparations=0;
  // The image arrives through the shared transport, which this fixture answers.
  const network={transfer:async(_url,file,{signal,onProgress})=>{
    signal?.throwIfAborted();transfers++;fs.writeFileSync(file,archive);onProgress({downloaded:archive.length,total:archive.length});
  }};
  t.mock.method(Transport,'downloadToFile',(...args)=>network.transfer(...args));
  const dependencies={image,retireMountTargets(){},capture:async(_file,_args,{signal})=>{
    signal?.throwIfAborted();preparations++;const target=path.join(directory,'derived/root');fs.mkdirSync(target,{recursive:true});
    if(!fs.existsSync(path.join(directory,'system.dmg')))fs.writeFileSync(path.join(directory,'system.dmg'),'original image');fs.writeFileSync(path.join(target,'.identity'),'verified');return '';
  }};
  const volume=path.join(root,'original');fs.mkdirSync(path.join(volume,'root/system/bin'),{recursive:true});
  fs.writeFileSync(path.join(volume,'root.identity'),image.sha256+'\n');fs.writeFileSync(path.join(volume,'root/system/build.prop'),'ro.build.id=original\n');
  const elf=Buffer.alloc(64);elf.writeUInt32BE(0x7f454c46);elf[4]=2;elf[5]=1;elf[6]=1;elf.writeUInt16LE(3,16);elf.writeUInt16LE(183,18);elf.writeUInt32LE(1,20);elf.writeUInt16LE(64,52);
  for(const name of ['linker64','app_process64'])fs.writeFileSync(path.join(volume,'root/system/bin',name),elf,{mode:0o755});
  const mounts=new Map(),imageDependencies={legacyLocations:()=>[],acquireLock:async()=>async()=>{},cloneOrCopy:(from,to)=>fs.promises.copyFile(from,to,fs.constants.COPYFILE_EXCL),
    command:async(file,args,options={})=>{
      if(file==='/usr/bin/plutil')return options.input;
      if(file==='/owned/extractor'){options.context.signal?.throwIfAborted();fs.cpSync(volume,path.dirname(args[1]),{recursive:true});return '';}
      assert.equal(file,'/usr/bin/hdiutil');
      if(args[0]==='info')return JSON.stringify({images:[...mounts].map(([mount,record])=>({...record,'system-entities':[{'mount-point':mount}]}))});
      if(args[0]==='create'){fs.writeFileSync(args.at(-1),'sparse');return '';}
      if(args[0]==='attach'){const mount=args[args.indexOf('-mountpoint')+1],base=args.at(-1),writeable=args.includes('-readwrite');fs.mkdirSync(mount,{recursive:true});if(!writeable)fs.cpSync(volume,mount,{recursive:true});mounts.set(mount,{'image-path':base,writeable});return '';}
      if(args[0]==='detach'){const mount=args[1];mounts.delete(mount);for(const name of fs.readdirSync(mount))fs.rmSync(path.join(mount,name),{recursive:true,force:true});return '';}
      if(args[0]==='convert'){fs.writeFileSync(args.at(-1),'original image');return '';}
      assert.fail('Unexpected image command');
    }};
  dependencies.imageDependencies=imageDependencies;
  dependencies.imageManager=require('../src/modules/android/system-image-manager').createManager({imageDependencies,
    extractorManager:{id:'android-art-image-extractor',resolveSelection:()=>({ready:true,version:'reader',install:{executablePath:'/owned/extractor',installDir:path.join(root,'reader')}})}});
  return {root,context,runtime,archive,image,directory,dependencies,network,downloads,history,get transfers(){return transfers;},get preparations(){return preparations;},options:{context,runtime}};
}

test('AIM image acquisition uses ordinary downloads through checksum/preparation and reuses the cached image',async t=>{
  const f=fixture(t),command=f.dependencies.imageDependencies.command;
  f.dependencies.imageDependencies.command=async(...args)=>{
    if(args[0]!=='/owned/extractor')return command(...args);
    const [task]=f.downloads.list();assert.equal(task.managerId,'android-system-image');assert.equal(task.sectionId,'default');
    assert.equal(task.detail,'Preparing…');assert.equal(task.downloaded,f.archive.length);
    return command(...args);
  };
  const first=await Aim.prepareSystem(f.options,f.dependencies);
  assert.equal(first.directory,f.directory);assert.equal(f.transfers,1);assert.deepEqual(f.downloads.list(),[]);
  assert.ok(f.history.some(rows=>rows.some(row=>row.status==='done')));
  assert.equal(fs.existsSync(path.join(f.directory,'system.zip')),false);
  f.context.confirmRuntimeInstall=()=>assert.fail('Cached image needs no download consent');
  f.network.transfer=()=>assert.fail('Cached image needs no transfer');
  const second=await Aim.prepareSystem(f.options,f.dependencies);
  assert.equal(second.image,first.image);assert.equal(f.transfers,1);assert.equal(f.preparations,2);assert.deepEqual(f.downloads.list(),[]);
});

test('AIM shared Cancel and launch cancellation stop the image task and remove its archive',async t=>{
  for(const from of ['downloads','launch'])await t.test(from,async t=>{
    const f=fixture(t),controller=new AbortController();f.context.signal=controller.signal;
    f.network.transfer=async(_url,file,{signal,onProgress})=>{
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
    const f=fixture(t),command=f.dependencies.imageDependencies.command;f.dependencies.imageDependencies.command=async(file,args,options)=>{
      if(file!=='/owned/extractor')return command(file,args,options);
      assert.equal(f.downloads.list()[0].detail,'Preparing…');
      f.downloads.cancel(f.downloads.list()[0].id);options.context.signal.throwIfAborted();
    };
    await assert.rejects(Aim.prepareSystem(f.options,f.dependencies),{name:'AbortError'});
    assert.deepEqual(f.downloads.list(),[]);assert.equal(fs.existsSync(path.join(f.directory,'system.zip')),false);
  });
  await t.test('checksum',async t=>{
    const f=fixture(t);f.network.transfer=async(_url,file)=>fs.writeFileSync(file,Buffer.alloc(f.archive.length));
    await assert.rejects(Aim.prepareSystem(f.options,f.dependencies),/checksum its publisher lists/);
    assert.equal(f.preparations,0);assert.deepEqual(f.downloads.list(),[]);
    assert.ok(f.history.some(rows=>rows.some(row=>row.status==='error'&&/checksum/.test(row.error))));
    assert.equal(fs.existsSync(path.join(f.directory,'system.zip')),false);
  });
});
