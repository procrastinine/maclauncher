const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('Android fcntl locking translates Linux records to real Mac kernel locks',t=>{
 if(process.platform!=='darwin')return t.skip('Requires macOS kernel file locking');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-file-lock-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const root=path.resolve(__dirname,'../src/modules/android/native');
 const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:15000});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run('clang',['-std=c11','-I'+root,path.join(__dirname,'fixtures/android-native/file-lock.c'),'-o',temp+'/probe']);
 assert.match(run(temp+'/probe',[]),/PASS Linux range, ownership, contention, unlock and OFD lifetime/);
});
