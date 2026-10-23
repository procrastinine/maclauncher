const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('./helpers/android-java');
test('shared application AppOps retires attributed starts with its Binder client',async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,jdk=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!jdk)return t.skip('Requires the complete Android runtime and Java21');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-appops-client-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:50}));
 const cp=['android-host.jar','android-framework.jar'].map(file=>path.resolve(runtime,file)).join(path.delimiter),env={...process.env};
 for(const key of Object.keys(env))if(/^(DYLD_|KL_|RESHADE_)/.test(key)||['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','CLASSPATH'].includes(key))delete env[key];
 Object.assign(env,(await require('../src/modules/android/process-channel').processNamespace(root,1)).environment);
 const run=(program,args)=>{const r=spawnSync(program,args,{env,encoding:'utf8',timeout:30000,maxBuffer:3<<20});assert.ifError(r.error);assert.equal(r.signal,null,r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
 run(path.join(jdk,'bin/javac'),['--release','21','-cp',cp,'-d',root,path.resolve('src/modules/android/native/java/maclauncher/android/framework/HostAppOps.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java'),path.resolve('tests/fixtures/android-framework-services/HostAppOpsClientDeathProbe.java')]);
 assert.match(run(path.join(jdk,'bin/java'),['-Xverify:all','-cp',root+path.delimiter+cp,'HostAppOpsClientDeathProbe',path.resolve(runtime),root]),/PASS shared AppOps client death/);
});
