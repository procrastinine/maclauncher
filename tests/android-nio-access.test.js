const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const{spawnSync}=require('node:child_process');
test('JVM NIO uses original scoped checks for Android shared accessibility and pre-existing views',t=>{
 const jdk=process.env.JAVA_HOME;if(!jdk||!fs.existsSync(path.join(jdk,'bin/javac')))return t.skip('Requires Java21 development tools');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-nio-access-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const fixture=path.resolve(__dirname,'fixtures/android-native'),native=path.resolve(__dirname,'../src/modules/android/native');
 const asm=require('../src/modules/android/native/asm-binary.json').files.map(item=>path.join(native,'tools',item.path)).join(path.delimiter);
 const run=(program,args)=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:30000,maxBuffer:2<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run(path.join(jdk,'bin/javac'),['--release','21','-cp',asm,'-d',root,
  native+'/java/maclauncher/android/framework/HostNio.java',native+'/java-jvm/maclauncher/android/framework/JvmNioAccess.java',
  native+'/portability/NioPortability.java',fixture+'/NioLeaseProbe.java',fixture+'/AndroidNioLeaseCalls.java',fixture+'/NioLeaseTransform.java']);
 const original=path.join(root,'AndroidNioLeaseCalls.class'),copy=path.join(root,'Original.class');fs.copyFileSync(original,copy);
 run(path.join(jdk,'bin/java'),['-cp',root+path.delimiter+asm,'maclauncher.android.portability.NioLeaseTransform',copy,original]);
 const options=[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-Xverify:all','-cp',root];
 assert.match(run(path.join(jdk,'bin/java'),[...options,'NioLeaseProbe']),/PASS original JDK NIO scope revokes and restores shared direct\/typed views/);
 assert.match(run(path.join(jdk,'bin/java'),[...options,'AndroidNioLeaseCalls']),/PASS original Android ByteBuffer hidden calls and allocation\/view bytecode retain JDK scoped access/);
});
