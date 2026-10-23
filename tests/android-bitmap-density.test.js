const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {frameworkJvmOptions}=require('../src/modules/android/jvm-options');
test('original bitmap density follows application binding and committed display changes',t=>{
  const home=process.env.JAVA_HOME,runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||!home||!runtime)return t.skip('Requires macOS, JAVA_HOME and KLEPTON_NATIVE_RUNTIME');
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'android-bitmap-density-'));t.after(()=>fs.rmSync(output,{recursive:true,force:true}));
  const jars=['android-host.jar','android-framework.jar'].map(x=>path.resolve(runtime,x));
  const sources=['BitmapDensityProbe','SyntheticResources','PackageManifest'].map(x=>path.resolve('tests/fixtures/android-framework-services',x+'.java'));
  sources.push(path.resolve('tests/fixtures/android-window-session/RuntimeFixture.java'));
  if(process.env.ANDROID_TEST_SOURCE_DENSITY==='1')for(const name of ['HostApplication','FrameworkResources'])sources.push(path.resolve('src/modules/android/native/java/maclauncher/android/framework',name+'.java'));
  execFileSync(path.join(home,'bin/javac'),['--release','21','-cp',jars.join(path.delimiter),'-d',output,...sources],{stdio:'pipe'});
  const result=execFileSync(path.join(home,'bin/java'),[...frameworkJvmOptions,'-Xverify:all','-Djava.awt.headless=true','-cp',[output,...jars].join(path.delimiter),'maclauncher.android.BitmapDensityProbe',path.resolve(runtime),output],{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});
  assert.match(result,/PASS bitmap pixel extent and density across original application bind and display changes/);
});
