const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
test('original Google providers retain opted-in defaults, explicit choices and billing callbacks without requesting purchases',async t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME,prepared=process.env.KLEPTON_MICROG_PREPARED,vending=process.env.KLEPTON_VENDING_PREPARED;
 if(process.platform!=='darwin'||!runtime||!home||!prepared||!vending)return t.skip('Requires Java21, Android runtime and prepared original microG Services and Companion APKs');
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-google-config-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
 const cp=[output,...['android-host.jar','android-framework.jar'].map(name=>path.resolve(runtime,name))].join(path.delimiter);
 const java='src/modules/android/native/java/maclauncher/android';
 const sources=['LocalProviders','framework/HostContext','framework/HostGoogleProviders','framework/HostProviderConnections','framework/HostActivityService','framework/HostProcessServices','framework/HostRemoteServices','framework/HostServiceDirectory'].map(name=>path.resolve(java,name+'.java'));
 execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',cp,'-d',output,...sources,path.resolve('tests/fixtures/android-framework-services/GoogleProviderConfigurationProbe.java'),path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java')],{stdio:'pipe'});
 const identity=await require('../src/modules/android/process-channel').processNamespace(output,1);
 const data=path.join(output,'profile');fs.mkdirSync(data);
 const text=execFileSync(path.join(home,'bin/java'),[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-Xverify:all','-cp',cp,'maclauncher.android.framework.GoogleProviderConfigurationProbe',path.resolve(runtime),data,path.resolve(prepared),path.resolve(vending)],{env:{...process.env,...identity.environment},encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});
 assert.match(text,/PASS original Google settings provider/);assert.match(text,/PASS original billing discovery and initialization callback/);
});
