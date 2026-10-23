const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
test('original process construction and application binding survive transport adaptation',t=>{
 const java=process.env.JAVA_HOME,framework=process.env.ANDROID_ORIGINAL_FRAMEWORK;
 if(!java||!framework)return t.skip('Requires Java21 and the complete original framework archive');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-original-spawn-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const native=path.resolve(__dirname,'../src/modules/android/native'),cp=[root,native+'/tools/*',path.resolve(framework)].join(path.delimiter);
 const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:20000});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
 run(java+'/bin/javac',['--release','21','-cp',cp,'-d',root,...['ServicePortability','MessageQueuePortability','UiPortability','UiHooks','UiHookClassFiles'].map(name=>native+'/framework/'+name+'.java'),path.join(__dirname,'fixtures/android-process-authority/OriginalSpawnTransform.java')]);
 assert.match(run(java+'/bin/java',['-Xverify:all','-cp',cp,'OriginalSpawnTransform',path.resolve(framework)]),/PASS original process\/binding\/Looper members/);
});
