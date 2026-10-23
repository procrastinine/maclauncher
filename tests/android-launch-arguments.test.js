const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { promisify } = require("node:util"), execute = promisify(require("node:child_process").execFile);
const Arguments = require("../src/modules/android/launch-arguments");

test("Android argument transport retains literal arrays and never inherits another game's parameters", t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"android-arguments-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const context={userDataDir:root,gameArguments:["space value","",'quote" slash\\',"line\nbreak","✨"]};
  const environment=Arguments.environment(context,{KEEP:"yes",MACLAUNCHER_GAME_ARGUMENTS:'["old"]'});
  assert.deepEqual(JSON.parse(environment.MACLAUNCHER_GAME_ARGUMENTS),context.gameArguments);
  assert.deepEqual(Arguments.environment({},environment),{KEEP:"yes"});
  const file=Arguments.prepareAgent(context),modified=fs.statSync(file).mtimeMs;
  assert.deepEqual(fs.readFileSync(file),fs.readFileSync(path.resolve(__dirname,"../src/modules/android/resources/launch-arguments.jar")));
  assert.equal(Arguments.prepareAgent(context),file);assert.equal(fs.statSync(file).mtimeMs,modified);
  assert.equal(Arguments.prepareAgent({gameArguments:[]}),null);
  assert.ok(Arguments.jvmOptions(file).at(-1).endsWith("=jvm"));
  const appOptions=Arguments.processOptions(context,{env:{KEEP:"yes"},stdio:"pipe"});
  assert.equal(appOptions.env.MACLAUNCHER_GAME_ARGUMENTS,environment.MACLAUNCHER_GAME_ARGUMENTS);
  assert.equal(Object.hasOwn(appOptions,"gameArguments"),false);
  const serviceOptions=Arguments.processOptions(context,appOptions,true);
  assert.equal(serviceOptions.gameArguments,false);
  assert.deepEqual(serviceOptions.env,{KEEP:"yes"});
  assert.equal(serviceOptions.stdio,"pipe");
});

const jdk=process.env.MACLAUNCHER_POLICY_JDK||"/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home";
const app=process.env.MACAPK_TEST_APP;
test("JVM and Mac.apk initial Intent bindings receive exact JSON before application startup", {skip:!app||!fs.existsSync(path.join(jdk,"bin/javac")),timeout:20000}, async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"android-arguments-bindings-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const lib=path.join(app,"Contents/lib"),framework=path.join(lib,"android-framework.jar"),loader=path.join(lib,"macapk-loader.jar"),classes=path.join(root,"classes");
  const sources={
    "maclauncher/android/framework/HostActivity.java":`package maclauncher.android.framework;
      public final class HostActivity { public static void attach(android.app.Activity activity,android.content.Context context,android.app.Application app,android.content.pm.ActivityInfo info){ activity.setIntent(new android.content.Intent(android.content.Intent.ACTION_MAIN)); } }`,
    "maclauncher/android/Host.java":`package maclauncher.android;
      public final class Host { public static void main(String[] args)throws Exception{android.app.Activity activity=new android.app.Activity();maclauncher.android.framework.HostActivity.attach(activity,null,null,null);System.out.print(activity.getIntent().getStringExtra("maclauncher.arguments"));} }`,
    "ArgumentsProbe.java":`public final class ArgumentsProbe { public static void main(String[] args)throws Exception{android.content.Intent intent=new android.content.Intent(android.content.Intent.ACTION_MAIN);Class<?> owner=Class.forName("com.macapk.loader.ActivityHost");var method=owner.getDeclaredMethod("macapkSetLauncherIntent",android.content.Intent.class);method.setAccessible(true);method.invoke(null,intent);System.out.print(intent.getStringExtra("maclauncher.arguments"));} }`
  };
  const files=Object.entries(sources).map(([relative,source])=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source);return file;});
  fs.mkdirSync(classes);await execute(path.join(jdk,"bin/javac"),["-cp",[framework,loader].join(path.delimiter),"-d",classes,...files]);
  const values=["space value","",'quote" slash\\',"line\nbreak","✨"],json=JSON.stringify(values);
  const agent=Arguments.prepareAgent({userDataDir:root,gameArguments:values});
  for(const [provider,entry]of [["jvm","maclauncher.android.Host"],["macapk","ArgumentsProbe"]]){
    const result=await execute(path.join(jdk,"bin/java"),["-Duser.home="+root,...Arguments.jvmOptions(agent,provider),"-cp",[classes,framework,loader].join(path.delimiter),entry],{
      timeout:10000,env:{...process.env,MACLAUNCHER_GAME_ARGUMENTS:json,MACAPK_ANDROID_ROOT:path.join(root,"android"),MACAPK_OFFLINE:"1",MACAPK_CLIPBOARD_HOST:"0",MACAPK_LOCATION_HOST:"0"}});
    assert.equal(result.stdout,json,provider);
    assert.deepEqual(JSON.parse(result.stdout),values,provider);
  }
});
