const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('One built inotify owner delivers native and original JVM descriptor and creation events',t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||process.arch!=='arm64'||!runtime)return t.skip('Requires an Apple Silicon Android runtime with current file ownership');
  const checkout=process.env.ANDROID_INOTIFY_SOURCE||path.resolve('src/external/libinotify-kqueue');
  if(!fs.existsSync(path.join(checkout,'sys/inotify.h')))return t.skip('Initialize libinotify-kqueue headers');
  const jdk=process.env.JAVA_HOME||spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim();
  if(!jdk)return t.skip('Java 21 is required');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-file-events-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const binary=path.join(root,'native'),data=path.join(root,'data'),classes=path.join(root,'classes');fs.mkdirSync(data);fs.mkdirSync(classes);
  function run(file,args){const r=spawnSync(file,args,{encoding:'utf8',timeout:45000});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout+r.stderr;}
  // Link the packaged owner, including its real pollable descriptors and inode
  // ownership. No fixture-built replacement or native registration is installed.
  const native=path.resolve(runtime,'native');
  run('clang',['-std=gnu11','-I'+checkout,'-I'+path.resolve('src/modules/android/native/file-events'),path.join(__dirname,'fixtures/android-file-events/native.c'),'-L'+native,'-lklepton-jvm','-Wl,-rpath,'+native,'-o',binary]);
  assert.match(run(binary,[data]),/PASS native descriptor events/);
  const cp=[classes,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
  run(path.join(jdk,'bin/javac'),['--release','21','-cp',cp,'-d',classes,path.join(__dirname,'fixtures/android-window-session/RuntimeFixture.java'),path.join(__dirname,'fixtures/android-file-events/JdkFileEvents.java')]);
  const {frameworkJvmOptions}=require('../src/modules/android/jvm-options');
  const output=run(path.join(jdk,'bin/java'),[...frameworkJvmOptions,'-Xcheck:jni','-Xverify:all','-cp',cp,'JdkFileEvents',path.resolve(runtime),data]);
  assert.match(output,/PASS original JDK stream, random access, NIO and inode ownership/);
  const operations=output.split('BEGIN original file operations')[1];assert.ok(operations,'Full native initialization completed');
  assert.doesNotMatch(operations,/WARNING in native method|FATAL ERROR|Exception in thread/);
});
