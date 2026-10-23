const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('Both execution engines share ANGLE blob persistence across cold and warm processes',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
 if(process.platform!=='darwin'||!runtime)return t.skip('Requires macOS and KLEPTON_NATIVE_RUNTIME');
 const source=path.resolve(__dirname,'../src/modules/android/native'),headers=path.resolve(__dirname,'../'+JSON.parse(fs.readFileSync(path.join(source,'gles-headers.json'))).directory);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-egl-cache-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const run=(cmd,args)=>{const result=spawnSync(cmd,args,{encoding:'utf8',timeout:30000});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout+result.stderr;};
 run('clang++',['-std=c++20','-fobjc-arc','-Wno-deprecated-declarations','-I'+source,'-I'+headers+'/include',path.join(__dirname,'fixtures/android-egl-window/BlobCacheProbe.mm'),'-o',root+'/probe']);
 const angle=path.resolve(runtime,'native/angle');
 const check=(program,directory,mode)=>{const output=run(program,[angle,directory,mode]);assert.match(output,mode==='cold'?/stores=1 hits=0/:/stores=0 hits=1/);assert.ok(output.includes('PASS '+mode+' actual ANGLE blob callbacks'));};
 check(root+'/probe',root,'cold');check(root+'/probe',root,'warm');
 const art=path.join(root,'art');fs.mkdirSync(art);
 run('clang++',['-std=c++20','-fobjc-arc','-fblocks','-Wno-deprecated-declarations','-DART_CACHE_ADAPTER=1','-I'+source,'-I'+headers+'/include',path.join(__dirname,'fixtures/android-egl-window/BlobCacheProbe.mm'),path.resolve('src/modules/android/art/native/egl-cache.mm'),'-o',root+'/art-probe']);
 check(root+'/art-probe',art,'cold');check(root+'/art-probe',art,'warm');
 assert.equal(fs.readdirSync(root+'/egl-programs').filter(n=>n.endsWith('.blob')).length,2);
 assert.equal(fs.readdirSync(art+'/egl-programs').filter(n=>n.endsWith('.blob')).length,2,'Separate selected application roots retain separate cache files');
});
