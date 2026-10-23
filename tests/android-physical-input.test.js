const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
test('ART and JVM share physical SDL input decoding and coordinate ownership',t=>{
 const sdl=process.env.ANDROID_SDL_FRAMEWORK;if(process.platform!=='darwin'||!sdl)return t.skip('Requires SDL3 headers');
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'android-physical-input-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:30000});assert.ifError(r.error);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 const native=path.resolve('src/modules/android/native'),fixture=path.resolve('tests/fixtures/android-window-session/physical-input-test.c'),binary=path.join(temp,'input');
 run('clang',['-std=c11','-O2','-Wall','-Wextra','-Werror','-F'+path.dirname(sdl),'-I'+native,fixture,'-o',binary]);assert.match(run(binary,[]),/PASS shared physical input/);
});
