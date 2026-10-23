const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');

test('original Google broker callbacks retain availability without background sign-in resolution',{timeout:90000},async t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME,prepared=process.env.KLEPTON_MICROG_PREPARED;
  if(process.platform!=='darwin'||!runtime||!home||!prepared)return t.skip('Requires Java 21, an Android runtime and the prepared original microG Services APK');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-google-sign-in-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const cp=[output,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
  const run=(program,args,options={})=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:75000,maxBuffer:8<<20,...options});assert.ifError(result.error);assert.equal(result.signal,null,result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);return result;};
  run(path.join(home,'bin/javac'),['--release','21','-implicit:none','-cp',cp,'-d',output,
    path.resolve('tests/fixtures/android-framework-services/GoogleSignInResolutionProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')]);
  const identity=await require('../src/modules/android/process-channel').processNamespace(output,1),env={...process.env,...identity.environment};
  for(const key of Object.keys(env))if(/^(DYLD_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|CLASSPATH$)/.test(key))delete env[key];
  const result=run(path.join(home,'bin/java'),[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-Dmaclauncher.dex.demand=true','-Xverify:all','-cp',cp,
    'maclauncher.android.framework.GoogleSignInResolutionProbe',path.resolve(runtime),path.resolve(prepared),path.join(output,'data')],{env});
  for(const message of ['original unadapted microG sign-in-required response exposes its resolution capability',
    'original microG broker callback shapes preserve SIGN_IN_REQUIRED without interactive resolution',
    'successful Google service responses retain original callback metadata and Binder owners',
    'explicit interactive account owner retains original sign-in resolution',
    'descriptor authority and unrelated provider behavior remain intact',
    'original Games Connect startup callback retains status4 without UI and preserves other statuses, response, explicit account role and transaction authority'])assert.ok(result.stdout.includes('PASS '+message),result.stdout+result.stderr);
});
