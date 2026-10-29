const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');

test('Android graphics lookup preserves the selected ANGLE provider namespace',t=>{
 const provider=process.env.ANDROID_ANGLE_PROVIDER||(process.env.KLEPTON_NATIVE_RUNTIME&&path.resolve(process.env.KLEPTON_NATIVE_RUNTIME,'native/angle'));
 if(process.platform!=='darwin'||!provider)return t.skip('Requires macOS and the actual ANGLE provider');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-graphics-symbols-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
 // The pinned header checkout is a nested input of the Android source.
 const headers=process.env.ANDROID_GLES_HEADERS||'src/external/maclauncher-android/src/external/android-gles-headers';
 const table=fs.readFileSync(path.join(headers,'src/libGLESv2/proc_table_egl_autogen.cpp'),'utf8');
 const names=[...table.matchAll(/\{"((?:gl|egl)\w+)"/g)].map(match=>match[1]);assert.ok(names.length>500);
 fs.writeFileSync(temporary+'/entries.txt',names.join('\n')+'\n');
 const run=(cmd,args)=>{const result=spawnSync(cmd,args,{encoding:'utf8',timeout:30000,maxBuffer:2<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout+result.stderr;};
 const jdk=process.env.JAVA_HOME||run('/usr/libexec/java_home',['-v','21']).trim();
 run('clang',['-std=gnu11','-O2','-Wall','-Wextra','-Werror','-I'+path.join(jdk,'include'),'-I'+path.join(jdk,'include/darwin'),'src/modules/android/native/eglbridge.c','tests/fixtures/android-native/graphics-symbols.c','-o',temporary+'/probe']);
 assert.match(run(temporary+'/probe',[path.resolve(provider),temporary+'/entries.txt']),/PASS selected ANGLE exports, extension lookup and cached absence/);
});
