const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
test('ART modes use the shared native window and commit display/input with original buffers',t=>{
 const library=process.env.ANDROID_ART_HOST,graphics=process.env.ANDROID_FRAME_LIBRARY,sdl=process.env.ANDROID_SDL;
 if(process.platform!=='darwin'||!library||!graphics||!sdl)return t.skip('Requires built ART physical host, shared presenter and SDL');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'art-orientation-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const executable=path.join(directory,'probe'),native=path.resolve('src/modules/android/native'),art=path.resolve('src/modules/android/art/native');
 function run(command,args,env=process.env){const result=spawnSync(command,args,{env,encoding:'utf8',timeout:30000,maxBuffer:2<<20});assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}
 run('clang++',['-std=c++20','-mmacosx-version-min=13.0','-fobjc-arc','-I'+native,'-I'+art,'tests/fixtures/android-art/PresentationProbe.mm','-framework','AppKit','-framework','QuartzCore','-o',executable]);
 const env={...process.env,DYLD_FRAMEWORK_PATH:path.dirname(path.resolve(sdl)),KLEPTON_FRAME_LIBRARY:path.resolve(graphics),MACLAUNCHER_ANDROID_ALLOW_ADS:'0',MACLAUNCHER_ART_BROWSER_SOCKET:path.join(directory,'browser'),MACLAUNCHER_ART_WIDTH:'320',MACLAUNCHER_ART_HEIGHT:'240'};
 assert.match(run(executable,[path.resolve(library),'modes'],env),/PASS shared physical native modes, original buffers, deferred display\/input commit and retirement/);
});
