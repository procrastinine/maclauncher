const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const Cache=require('../src/modules/android/prepared-cache');
const Preparation=require('../src/modules/android/prepare');
const Digests=require('../src/modules/android/preparation-digests');

test('Native code metadata shares preparation ownership and leaves warm APK identities unchanged',async t=>{
 const bootstrap=process.env.ANDROID_ART_BOOTSTRAP;
 if(process.platform!=='darwin'||!bootstrap)return t.skip('Requires the native Android bootstrap');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-code-inodes-')),children=new Set();
 t.after(()=>{for(const child of children)child.kill('SIGKILL');fs.rmSync(temporary,{recursive:true,force:true});});
 const app=path.join(temporary,'android/apps/service-fixture'),directory=path.join(app,'prepared'),key='a'.repeat(64),root=path.join(directory,key),source=path.join(root,'base.apk');
 fs.mkdirSync(root,{recursive:true});const bytes=Buffer.alloc(1024*1024,7),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
 fs.writeFileSync(source,bytes,{mode:0o600});
 fs.writeFileSync(path.join(root,'prepared.json'),JSON.stringify({schemaVersion:2,key,apkSha256:sha256,files:[],metadata:{packageName:'example.service'}}));
 const receipt=fs.readFileSync(path.join(root,'prepared.json'));
 const initialize=()=>{
  const child=spawn(bootstrap,['initialize-package',root,source],{stdio:['ignore','ignore','pipe']});children.add(child);let stderr='';
  child.stderr.on('data',bytes=>stderr+=bytes);
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{children.delete(child);code===0?resolve():reject(Error('Native initializer failed: '+stderr));});});
  return{child,done};
 };
 let entered,release;
 const reading=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),open=fs.promises.open.bind(fs.promises);let pause=true,reads=0;
 t.mock.method(fs.promises,'open',async(...args)=>{
  const handle=await open(...args);
  if(args[0]===source){const create=handle.createReadStream.bind(handle);handle.createReadStream=options=>{
   reads++;const stream=create(options);
   if(!pause)return stream;pause=false;
   return(async function*(){entered();await gate;yield*stream;})();
  };}
  return handle;
 });
 const hashing=Cache.locked(directory,()=>Preparation.fileHash(source));hashing.catch(()=>{});
 await reading;const first=initialize();first.done.catch(()=>{});
 await new Promise(resolve=>setTimeout(resolve,150));
 const exitedBeforeRelease=first.child.exitCode!==null;
 release();
 assert.equal(await hashing,sha256,'First native metadata publication cannot alter an APK during verification');
 await first.done;assert.equal(exitedBeforeRelease,false,'Native installation waits for the existing preparation lock');
 const digests=Digests.open(app);
 assert.equal(await Cache.locked(directory,()=>Preparation.fileHash(source,undefined,digests)),sha256);digests.save();
 const identity=Digests.identity(fs.statSync(source,{bigint:true})),readCount=reads;
 const parallel=[];
 for(let i=0;i<6;i++){
  parallel.push(initialize().done);
  parallel.push(Cache.locked(directory,()=>Preparation.fileHash(source,undefined,digests)));
 }
 await Promise.all(parallel);
 assert.equal(Digests.identity(fs.statSync(source,{bigint:true})),identity,'Hot starts do not rewrite APK modes or guest inode attributes');
 assert.equal(reads,readCount,'Unchanged published code retains the cached digest');
 assert.deepEqual(fs.readFileSync(path.join(root,'prepared.json')),receipt,'Native metadata initialization never replaces the prepared generation');
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),sha256);
});
