const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');

// Small real APK cluster used by the optional full-runtime split execution test.
// Tools are existing Android SDK inputs; this helper does not acquire anything.
function build({ root, runtime, javaHome, aapt2, r8 }) {
  fs.mkdirSync(root, { recursive: true });
  const framework = path.join(runtime, 'android-framework.jar'), host = path.join(runtime, 'android-host.jar');
  const run = (command, args, options = {}) => {
    const result = cp.spawnSync(command, args, { encoding: 'utf8', timeout: 45000, maxBuffer: 2 << 20, ...options });
    if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed: ${result.error || result.stdout + result.stderr}`);
    return result.stdout;
  };
  const java = path.join(javaHome, 'bin/java'), javac = path.join(javaHome, 'bin/javac');
  const appClasses = path.join(root, 'app-classes'), appSource = path.join(root, 'app-source');
  fs.mkdirSync(appClasses, { recursive: true }); fs.mkdirSync(appSource, { recursive: true });
  const sources = {
    BaseType: `public class BaseType {
      public static int answer(){return 1;}
      public static void report(android.content.Context context,String name){
        String[] names={"base_value","parent_value","child_value","sibling_value"};String result="";
        for(int i=0;i<names.length;i++){if(i!=0)result+="|";int id=context.getResources().getIdentifier(names[i],"string","fixture.isolated");if(id!=0)result+=context.getString(id);}
        System.setProperty("fixture.isolated."+name+".resources",result);
        System.setProperty("fixture.isolated."+name+".loader",Integer.toString(System.identityHashCode(context.getClassLoader())));
      }
    }`,
    BaseApplication: 'public class BaseApplication extends android.app.Application {}',
    ParentType: 'public class ParentType extends BaseType { public static int answer(){return BaseType.answer()+10;} }',
    ChildType: 'public class ChildType extends ParentType { public static int answer(){return ParentType.answer()+1;} }',
    SiblingType: 'public class SiblingType extends BaseType {}',
    ChildActivity: 'public class ChildActivity extends android.app.Activity {}',
    ParentService: `public class ParentService extends android.app.Service {
      public void onCreate(){super.onCreate();BaseType.report(this,"service");}
      public android.os.IBinder onBind(android.content.Intent intent){return null;}
    }`,
    ChildReceiver: `public class ChildReceiver extends android.content.BroadcastReceiver {
      public void onReceive(android.content.Context context,android.content.Intent intent){BaseType.report(context,"receiver");}
    }`,
    ChildProvider: `public class ChildProvider extends android.content.ContentProvider {
      public boolean onCreate(){BaseType.report(getContext(),"provider");return true;}
      public String getType(android.net.Uri uri){return null;}
      public android.database.Cursor query(android.net.Uri uri,String[] projection,String selection,String[] args,String order){return null;}
      public android.net.Uri insert(android.net.Uri uri,android.content.ContentValues values){return null;}
      public int delete(android.net.Uri uri,String selection,String[] args){return 0;}
      public int update(android.net.Uri uri,android.content.ContentValues values,String selection,String[] args){return 0;}
    }`
  };
  const javaSources = Object.entries(sources).map(([name, body]) => {
    const file = path.join(appSource, name + '.java'); fs.writeFileSync(file, 'package fixture.isolated;\n' + body); return file;
  });
  run(javac, ['--release', '8', '-cp', framework, '-d', appClasses, ...javaSources]);
  const cluster = [
    { id: 'base', classes: ['BaseType', 'BaseApplication'], components: '', values: ['base'] },
    { id: 'parent', privateValue: 21, classes: ['ParentType', 'ParentService'], components: '<service android:name=".ParentService" android:exported="false"/>', values: ['parent'] },
    { id: 'child', parent: 'parent', classes: ['ChildType', 'ChildActivity', 'ChildReceiver', 'ChildProvider'], values: ['child'],
      components: '<activity android:name=".ChildActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity><receiver android:name=".ChildReceiver" android:exported="false"><intent-filter><action android:name="fixture.isolated.RECEIVE"/></intent-filter></receiver><provider android:name=".ChildProvider" android:authorities="fixture.isolated.provider" android:exported="false"/>' },
    { id: 'sibling', privateValue: 84, classes: ['SiblingType'], components: '', values: ['sibling'] }
  ];
  const stable = path.join(root, 'resource-ids.txt'), unsigned = [], signed = [];
  fs.writeFileSync(stable, ['base', 'child', 'parent', 'sibling'].map((name, index) => `fixture.isolated:string/${name}_value = 0x7f01000${index}`).join('\n') + '\n');
  for (const item of cluster) {
    const directory = path.join(root, item.id); fs.mkdirSync(path.join(directory, 'res/values'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'assets')); fs.mkdirSync(path.join(directory, 'dex'));
    fs.writeFileSync(path.join(directory, 'assets', 'owned-isolated-' + item.id + '.txt'), item.id);
    const values = '<resources>' + item.values.map(name => `<string name="${name}_value">${item.id === name ? name + '-resource' : ''}</string>`).join('') + '</resources>';
    fs.writeFileSync(path.join(directory, 'res/values/strings.xml'), values);
    const split = item.id === 'base' ? 'android:isolatedSplits="true"' : `split="feature.${item.id}" android:isFeatureSplit="true"`;
    fs.writeFileSync(path.join(directory, 'AndroidManifest.xml'), `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="fixture.isolated" android:versionCode="1" android:versionName="1" ${split}><uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36"/>${item.parent ? `<uses-split android:name="feature.${item.parent}"/>` : ''}<application android:hasCode="true" ${item.id === 'base' ? 'android:name=".BaseApplication" android:label="Isolated split fixture"' : ''}>${item.components}</application></manifest>`);
    const compiled = path.join(directory, 'resources.zip');
    run(aapt2, ['compile', '--dir', path.join(directory, 'res'), '-o', compiled]);
    const apk = path.join(root, item.id === 'base' ? 'base.apk' : 'split_feature.' + item.id + '.apk');
    run(aapt2, ['link', '-I', framework, '--manifest', path.join(directory, 'AndroidManifest.xml'), '-A', path.join(directory, 'assets'),
      '--stable-ids', stable, '-o', apk, compiled]);
    const privateClasses = [];
    if (item.privateValue !== undefined) {
      const source = path.join(directory, 'PrivateValue.java'), classes = path.join(directory, 'private-classes');
      fs.mkdirSync(classes); fs.writeFileSync(source, `package fixture.isolated; public class PrivateValue { public static int answer(){return ${item.privateValue};} }`);
      run(javac, ['--release', '8', '-d', classes, source]); privateClasses.push(path.join(classes, 'fixture/isolated/PrivateValue.class'));
    }
    run(java, ['-cp', r8, 'com.android.tools.r8.D8', '--min-api', '26', '--lib', framework, '--classpath', appClasses,
      '--output', path.join(directory, 'dex'), ...item.classes.map(name => path.join(appClasses, 'fixture/isolated', name + '.class')), ...privateClasses]);
    run('/usr/bin/zip', ['-q', '-j', apk, path.join(directory, 'dex/classes.dex')]);
    unsigned.push(apk); signed.push(path.join(root, 'signed-' + path.basename(apk)));
  }
  const overlay = path.join(root, 'overlay'), tools = path.join(root, 'tools');
  fs.mkdirSync(overlay); fs.mkdirSync(tools);
  const javaHelper = require('./android-java');
  const compile = (args) => {
    const result = javaHelper.spawnSync(javac, args, { env: { ...process.env, KLEPTON_NATIVE_RUNTIME: runtime }, encoding: 'utf8', timeout: 45000, maxBuffer: 2 << 20 });
    if (result.error || result.status !== 0) throw new Error(result.error || result.stdout + result.stderr);
  };
  const apksig = path.resolve('src/modules/android/native/tools/apksig.jar');
  compile(['--release', '21', '-cp', [host, framework, apksig].join(path.delimiter), '-d', overlay,
    'src/modules/android/native/java-jvm/maclauncher/android/framework/HostDexFiles.java',
    'src/modules/android/native/java/maclauncher/android/framework/HostApplication.java',
    'src/modules/android/native/java/maclauncher/android/framework/HostActivity.java',
    'src/modules/android/native/java/maclauncher/android/framework/HostSharedLibraries.java',
    'src/modules/android/native/java/com/android/server/compat/HostPlatformCompat.java',
    'tests/fixtures/android-window-session/RuntimeFixture.java',
    'tests/fixtures/android-framework-services/IsolatedSplitProbe.java',
    'tests/fixtures/android-framework-services/SignApkSet.java']);
  run(path.join(javaHome, 'bin/keytool'), ['-genkeypair', '-alias', 'owned', '-keystore', path.join(root, 'key.p12'), '-storetype', 'PKCS12',
    '-storepass', 'test-only-password', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '1', '-dname', 'CN=Owned isolated split test', '-noprompt']);
  run(java, ['-cp', [overlay, apksig].join(path.delimiter), 'SignApkSet', path.join(root, 'key.p12'), ...unsigned.flatMap((file, index) => [file, signed[index]])]);
  const converter = [path.join(runtime, 'converter-overlay.jar'), path.join(runtime, 'dex2jvm.jar')].join(path.delimiter);
  compile(['--release', '21', '-cp', converter, '-d', tools, 'src/modules/android/native/converter/ConvertApkSet.java']);
  const converted = path.join(root, 'converted.jar');
  run(java, ['-Dmaclauncher.dex.demand=true', '-cp', tools + path.delimiter + converter, 'io.github.kksimp.dex2jvm.ConvertApkSet', path.join(runtime, 'android-api-metadata.jar'), converted, ...signed]);
  return { root, runtime, java, overlay, signed, converted, classpath: [overlay, host, framework].join(path.delimiter) };
}
module.exports = { build };
