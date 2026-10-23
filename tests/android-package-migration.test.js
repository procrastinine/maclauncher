const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');

test('Original Settings imports retained package identities before allocation',{timeout:30000},t=>{
 const runtime=process.env.KLEPTON_NATIVE_RUNTIME,home=process.env.JAVA_HOME;
 if(process.platform!=='darwin'||!runtime||!home)return t.skip('Requires macOS, JAVA_HOME and KLEPTON_NATIVE_RUNTIME');
 const root=path.resolve(runtime),temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-package-migration-')));
 t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const source=path.resolve('src/modules/android/native'),fixture=path.resolve('tests/fixtures/android-package-metadata');
 const cp=[temp,path.join(root,'android-host.jar'),path.join(root,'android-framework.jar'),path.join(source,'tools/*')].join(path.delimiter);
 const run=(name,args)=>execFileSync(path.join(home,'bin',name),args,{encoding:'utf8',timeout:20000,maxBuffer:2<<20});
 run('javac',['--release','21','-cp',cp,'-d',temp,path.join(source,'framework/ServicePortability.java'),path.join(source,'framework/PendingIntentCalls.java'),
   path.join(source,'java/com/android/server/pm/HostPackageMigration.java'),path.join(fixture,'PackageMigrationTransform.java'),
   path.join(fixture,'PackageMigrationProbe.java')]);
 run('java',['-cp',cp,'PackageMigrationTransform',path.join(root,'android-framework.jar'),temp]);
 const cert=fs.readdirSync(path.join(root,'android-root/system/etc/security/cacerts')).find(name=>name.endsWith('.0'));assert.ok(cert);
 const output=run('java',[...require('../src/modules/android/jvm-options').frameworkJvmOptions,'-Xverify:all','-cp',cp,
   'com.android.server.pm.PackageMigrationProbe',root,path.join(temp,'data'),String(process.getuid()),path.join(root,'android-root/system/etc/security/cacerts',cert)]);
 assert.match(output,/PASS original Settings migration/);
});
