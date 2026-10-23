const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {withCatalogLock}=require('../src/modules/android/catalog-lock');

for(const abandon of [false,true])test('kernel catalog ownership survives '+(abandon?'controller death':'independent controllers'),{timeout:10000},async t=>{
 if(process.platform!=='darwin')return t.skip('Requires the macOS lockf owner');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-catalog-lock-')),children=[];
 t.after(async()=>{for(const child of children){child.stdin.end();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}await Promise.all(children.map(child=>child.closed));fs.rmSync(root,{recursive:true,force:true});});
 const file=path.join(root,'catalog.lock'),journal=path.join(root,'journal');
 function controller(name){
  const child=spawn(process.execPath,[path.join(__dirname,'fixtures/android-catalog-lock/holder.cjs'),file,journal,name],{stdio:['pipe','pipe','pipe']});
  child.closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));children.push(child);
  child.ready=new Promise((resolve,reject)=>{child.stdout.once('data',bytes=>{assert.equal(String(bytes),'acquired\n');resolve();});child.once('error',reject);child.closed.then(result=>{if(result.code!==0)reject(Error('Controller exited before acquiring: '+JSON.stringify(result)));});});
  return child;
 }
 const first=controller('first');await first.ready;const inode=fs.statSync(file).ino;
 const second=controller('second');
 if(abandon)first.kill('SIGKILL');else first.stdin.end();
 await first.closed;await second.ready;second.stdin.end();assert.equal((await second.closed).code,0);
 assert.deepEqual(fs.readFileSync(journal,'utf8').trim().split('\n'),abandon?
  ['first:enter','second:enter','second:leave']:['first:enter','first:leave','second:enter','second:leave']);
 assert.equal(fs.statSync(file).ino,inode,'retirement preserves the same kernel lock inode');
 const failure=Error('Original operation failure');await assert.rejects(withCatalogLock(file,()=>{throw failure;}),error=>error===failure);
 assert.equal(await withCatalogLock(file,async()=>42),42,'a rejected operation releases its exact holder');
});
