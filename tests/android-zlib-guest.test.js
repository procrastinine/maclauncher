const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('./helpers/android-java');

test('installed original libz owns guest compression, callbacks and gzip streams',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,include=process.env.ANDROID_NDK_HEADERS,
    jdk=process.env.JAVA_HOME,linker=process.env.ANDROID_ARM32_ELF_LINKER;
  if(process.platform!=='darwin'||process.arch!=='arm64'||![runtime,include,jdk,linker].every(Boolean))
    return t.skip('Requires an Android runtime containing original libz, NDK headers, Java21 and ELF linker');
  const library=path.join(runtime,'android-root/system/lib64/libz.so');
  assert.ok(fs.existsSync(library),'The supplied runtime contains the selected original libz product');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-zlib-guest-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const run=(command,args)=>{const result=spawnSync(command,args,{encoding:'utf8',timeout:30000,maxBuffer:4<<20});assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const fixture=path.resolve(__dirname,'fixtures/android-native'),objects=[];
  for(const name of ['zlib-family','gzip-family']){
    const object=path.join(temporary,name+'.o');objects.push(object);
    run('clang',['--target=aarch64-linux-android36','-fPIC','-fno-builtin','-O1','-Wall','-Wextra','-Werror','-D_GNU_SOURCE','-isystem',include,'-isystem',include+'/aarch64-linux-android','-c',path.join(fixture,name+'.c'),'-o',object]);
  }
  // Only the fixture is compiled here. The complete library and its original
  // dependency closure are products of the normal component build.
  const probe=path.join(temporary,'libzprobe.so');
  run(linker,['-flavor','gnu','-shared','--hash-style=both','-soname','libzprobe.so','-o',probe,...objects,library]);
  const cp=temporary+path.delimiter+path.join(runtime,'android-host.jar');
  run(path.join(jdk,'bin/javac'),['--release','21','-cp',cp,'-d',temporary,path.join(fixture,'../android-window-session/RuntimeFixture.java'),path.join(fixture,'ZlibGuestProbe.java')]);
  assert.match(run(path.join(jdk,'bin/java'),['-cp',cp,'ZlibGuestProbe',runtime,temporary+'/data',probe]),/PASS installed original guest compression and gzip ownership/);
});
