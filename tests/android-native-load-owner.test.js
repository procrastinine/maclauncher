const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('every exported Java native module owns its JNI load entry',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;if(process.platform!=='darwin'||!runtime)return t.skip('Requires an Android native runtime');
 const native=path.join(runtime,'native');let checked=0;
 for(const entry of fs.readdirSync(native,{withFileTypes:true})){
  if(!entry.isFile()||!entry.name.endsWith('.dylib'))continue;
  const symbols=spawnSync('nm',['-gU',path.join(native,entry.name)],{encoding:'utf8',maxBuffer:32*1024*1024,timeout:30000});assert.ifError(symbols.error);assert.equal(symbols.status,0,symbols.stderr);
  if(!/\b_Java_[^\n]+$/m.test(symbols.stdout))continue;
  checked++;assert.match(symbols.stdout,/\b_JNI_OnLoad$/m,entry.name+' must own initialization rather than inherit a dependency entry');
 }
 assert.ok(checked>0,'The runtime contains Java native modules');
});
