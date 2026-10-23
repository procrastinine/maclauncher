const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('both Android VMs share the physical CoreAudio device owner',t=>{
 if(process.platform!=='darwin')return t.skip('Requires CoreAudio');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-audio-device-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 const root=path.resolve(__dirname,'../src/modules/android/native'),binary=path.join(temporary,'probe');
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 run('clang',['-std=c11','-fblocks','-arch','arm64','-mmacosx-version-min=13.0','-Wall','-Wextra','-Werror','-I'+root,path.join(root,'audio-device.c'),path.join(__dirname,'fixtures/android-audio/DeviceProbe.c'),'-framework','CoreAudio','-framework','CoreFoundation','-o',binary]);
 assert.match(run(binary,[]),/PASS shared physical CoreAudio inventory, format, identity, strings and monitor lifetime/);
});
