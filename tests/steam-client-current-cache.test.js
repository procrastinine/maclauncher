const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('Steam component status reuses verified bytes and invalidates on file or receipt changes',t=>{
 const native=require('../src/modules/shared/runtime/pinned-native-manager'),original=native.hashFile;let hashes=0;
 t.mock.method(native,'hashFile',(...args)=>{hashes++;return original(...args);});
 delete require.cache[require.resolve('../src/modules/crossover/runtime/steam-client-components')];
 const client=require('../src/modules/crossover/runtime/steam-client-components');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'steam-current-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const store=path.join(root,'runtimes/steam-client-components'),sha='a'.repeat(40),dir=path.join(store,sha);fs.mkdirSync(dir,{recursive:true});
 // Both clients, each a PE image of its own CPU.
 const {peFixture}=require('./helpers/pe-fixture'),image=is64=>{const f=peFixture({is64});f.bytes.writeUInt16LE(0x2102,f.peOffset+22);return f.bytes;};
 const file=path.join(dir,'steamclient.dll'),bytes=image(false),other=path.join(dir,'steamclient64.dll');fs.writeFileSync(file,bytes);fs.writeFileSync(other,image(true));
 const record={archiveSha1:sha,clients:{i386:'steamclient.dll',x86_64:'steamclient64.dll'},files:[{path:'steamclient.dll',sha256:original(file),size:bytes.length},
  {path:'steamclient64.dll',sha256:original(other),size:fs.statSync(other).size}]};hashes=0;
 const write=()=>fs.writeFileSync(path.join(store,'active.json'),JSON.stringify(record));write();
 assert.ok(client.current(root));assert.ok(client.current(root));assert.equal(hashes,2);
 fs.utimesSync(file,new Date(),new Date(Date.now()+2000));assert.ok(client.current(root));assert.equal(hashes,3);
 fs.writeFileSync(file,Buffer.concat([bytes.subarray(0,-1),Buffer.from('!')]));assert.equal(client.current(root),null);assert.equal(hashes,4);
 fs.writeFileSync(file,bytes);assert.ok(client.current(root));
 record.files[0].sha256='b'.repeat(64);write();assert.equal(client.current(root),null);
 fs.unlinkSync(file);fs.symlinkSync('/etc/hosts',file);assert.equal(client.current(root),null);
});
