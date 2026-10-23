const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('native ELF and libcore share the complete xattr syscall family',{skip:process.platform!=='darwin'},t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-xattr-native-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const source=path.resolve(__dirname,'../src/modules/android/native'),binary=path.join(tmp,'probe');
 let r=spawnSync('clang',['-std=c11','-O2','-Wall','-Wextra','-Werror','-I'+source,path.join(source,'file-xattrs.c'),path.resolve(__dirname,'fixtures/android-native/file-xattrs.c'),'-o',binary],{encoding:'utf8',timeout:15000});
 assert.equal(r.status,0,r.stdout+r.stderr);r=spawnSync(binary,[tmp],{encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/PASS complete xattr syscall family/);
});
test('Original libcore extended attributes use actual private file metadata',t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME||spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout?.trim();
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires macOS, runtime and Java21');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'android-xattr-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:15000});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 const library=path.join(tmp,'filesystem.dylib'),cp=[tmp,...['android-host.jar','android-framework.jar'].map(n=>path.resolve(runtime,n))].join(path.delimiter);
 const native=path.resolve(runtime,'native'),source=path.resolve(__dirname,'../src/modules/android/native');
 run('clang',['-dynamiclib','-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),path.join(source,'framework-filesystem.c'),path.join(source,'file-xattrs.c'),'-L'+native,'-lklepton-jvm','-Wl,-rpath,'+native,'-o',library]);
 run(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',tmp,path.resolve(__dirname,'fixtures/android-native/ExtendedAttributesProbe.java')]);
 const r=run(path.join(home,'bin/java'),['-Xverify:all','-Xcheck:jni','-cp',cp,'libcore.io.ExtendedAttributesProbe',path.resolve(runtime),tmp,library]);
 assert.match(r.stdout,/PASS original Linux xattr/);assert.doesNotMatch(r.stdout+r.stderr,/WARNING|FATAL/);
});
