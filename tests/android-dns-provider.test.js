const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawnSync}=require('./helpers/android-java');

test('Android DNS policy covers Java resolver SPI and original libcore without network access',async t=>{
  const runtime=process.env.KLEPTON_NATIVE_RUNTIME;
  if(process.platform!=='darwin'||!runtime)return t.skip('Requires macOS and KLEPTON_NATIVE_RUNTIME');
  const home=process.env.JAVA_HOME||spawnSync('/usr/libexec/java_home',['-v','21'],{encoding:'utf8'}).stdout.trim();
  if(!home||!fs.existsSync(path.join(home,'bin/javac')))return t.skip('Requires Java 21 development tools');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-dns-'));t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const source=path.resolve(__dirname,'../src/modules/android/native'),fixtures=path.join(__dirname,'fixtures/android-native'),library=path.join(temporary,'dns.dylib');
  const {prepareNetworkPolicy}=await import(pathToFileURL(path.join(source,'network-policy-source.mjs')).href);prepareNetworkPolicy(temporary);
  const run=(command,args)=>{const r=spawnSync(command,args,{encoding:'utf8',timeout:15000});assert.equal(r.error,undefined,r.error?.message);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout;};
  run('clang',['-std=c11','-Wall','-Wextra','-Werror','-dynamiclib','-I'+source,'-I'+temporary,'-I'+path.join(home,'include'),'-I'+path.join(home,'include/darwin'),
    path.join(source,'network-policy.c'),path.join(fixtures,'network-resolver-probe.c'),'-o',library]);
  const classpath=[temporary,path.resolve(runtime,'android-host.jar'),path.resolve(runtime,'android-framework.jar')].join(path.delimiter);
  run(path.join(home,'bin/javac'),['--release','21','-cp',classpath,'-d',temporary,
    path.join(source,'java/maclauncher/android/net/HostNetworkPolicy.java'),path.join(source,'java-jvm/maclauncher/android/net/HostInetAddressResolverProvider.java'),path.join(fixtures,'DnsPolicyProbe.java')]);
  const services=path.join(temporary,'META-INF/services');fs.mkdirSync(services,{recursive:true});
  fs.writeFileSync(path.join(services,'java.net.spi.InetAddressResolverProvider'),'maclauncher.android.net.HostInetAddressResolverProvider\n');
  for(const allow of ['false','true'])assert.match(run(path.join(home,'bin/java'),['-Xverify:all','-Xcheck:jni','--add-exports=java.base/sun.net=ALL-UNNAMED','-cp',classpath,'maclauncher.android.net.DnsPolicyProbe',library,allow]),/PASS Android DNS SPI, original libcore policy/);
});
