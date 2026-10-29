package maclauncher.android;
import java.nio.file.*;import java.util.*;import org.json.*;
public final class SourceApksProbe {
 static int checks;static JSONObject base;static Path root,config;
 static void check(boolean b){checks++;if(!b)throw new AssertionError(checks);}
 static LaunchConfig read(JSONObject j)throws Exception{Files.writeString(config,j.toString());return LaunchConfig.read(config);}
 static JSONObject object()throws Exception{return new JSONObject(base.toString());}
 static JSONArray array(Object... values){return new JSONArray(Arrays.asList(values));}
 static void bad(JSONObject j)throws Exception{try{read(j);throw new AssertionError("accepted "+j.opt("sourceApks"));}catch(java.io.IOException expected){checks++;}}
 public static void main(String[] args)throws Exception{
  Path work=Path.of(args[0]);root=Files.createDirectory(work.resolve("files"));config=work.resolve("config.json");base=new JSONObject();base.put("schemaVersion",1).put("packageName","owned.fixture").put("versionName","1").put("versionCode",1).put("activityClass","owned.fixture.Activity").put("title","Owned metadata").put("width",512).put("height",384);for(String key:List.of("runtimeRoot","nativeRoot","assetsRoot","resourcesRoot","filesRoot","cacheRoot"))base.put(key,work.toString());Path converted=work.resolve("converted.jar");try(var empty=new java.util.zip.ZipOutputStream(Files.newOutputStream(converted))){}base.put("convertedJar",converted.toString());Path first=Files.writeString(root.resolve("base.apk"),"base"),other=Files.writeString(root.resolve("split.apk"),"split");base.put("sourceApk",first.toString());
  check(read(object()).sourceApks().equals(List.of(first.toRealPath())));
  var ordered=read(object().put("sourceApks",array("base.apk","split.apk"))).sourceApks();check(ordered.equals(List.of(first.toRealPath(),other.toRealPath())));try{ordered.clear();throw new AssertionError();}catch(UnsupportedOperationException expected){checks++;}
  check(read(object().put("sourceApks",array(first.toString(),other.toString()))).sourceApks().equals(ordered));
  bad(object().put("sourceApks",array()));bad(object().put("sourceApks",array("split.apk","base.apk")));bad(object().put("sourceApks",array("base.apk","base.apk")));bad(object().put("sourceApks",array("base.apk",first.toString())));
  Files.createLink(root.resolve("hard.apk"),first);bad(object().put("sourceApks",array("base.apk","hard.apk")));
  Files.createSymbolicLink(root.resolve("link.apk"),other);bad(object().put("sourceApks",array("base.apk","link.apk")));
  Files.createDirectory(root.resolve("directory.apk"));bad(object().put("sourceApks",array("base.apk","directory.apk")));bad(object().put("sourceApks",array("base.apk","missing.apk")));
  for(Object entry:List.of(".","..","../files/split.apk","nested/split.apk","nested\\split.apk",1,true,JSONObject.NULL,new JSONArray()))bad(object().put("sourceApks",array("base.apk",entry)));
  Path outside=Files.writeString(work.resolve("outside.apk"),"outside");bad(object().put("sourceApks",array("base.apk",outside.toString())));bad(object().put("sourceApks",array("base.apk","x\0y")));bad(object().put("sourceApks",array("base.apk","x".repeat(4097))));
  for(Object notArray:List.of("base.apk",1,JSONObject.NULL))bad(object().put("sourceApks",notArray));bad(object().put("title",array("base.apk")));
  JSONArray maximum=new JSONArray().put("base.apk");for(int i=1;i<64;i++){String n="split"+i+".apk";Files.writeString(root.resolve(n),"x");maximum.put(n);}check(read(object().put("sourceApks",maximum)).sourceApks().size()==64);maximum.put("split.apk");bad(object().put("sourceApks",maximum));
  JSONObject size=object().put("sourceApks",array("base.apk"));
  // Metadata comes from the APK; fill the document with options read after admission.
  for(String key:List.of("processExitHistoryJson","installedPackagesJson","accountProviderPackage"))size.put(key,"[]"+" ".repeat(16382));
  size.put("processName","[]");int bytes=size.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
  size.put("processName","[]"+" ".repeat(65536-bytes));check(read(size).sourceApks().size()==1);
  size.put("processName",size.getString("processName")+" ");bad(size);
  bad(object().put("title","x".repeat(16385))); // Individual value limit remains unchanged.
  Files.writeString(config,object().toString().replaceFirst("\\{","{\"sourceApks\":[\"base.apk\"],\"sourceApks\":[\"base.apk\"],"));try{LaunchConfig.read(config);throw new AssertionError();}catch(java.io.IOException expected){checks++;}
  // Two owned resource-only APKs prove the exact validated order reaches both consumers.
  SyntheticResources.apk(first,"","Base value",null);SyntheticResources.apk(other,"en","English value","owned/split.txt");
  var c=read(object().put("sourceApks",array("base.apk","split.apk")));var apks=c.sourceApks();check(apks.equals(List.of(first.toRealPath(),other.toRealPath())));
  java.util.Locale.setDefault(java.util.Locale.US);var actualResources=maclauncher.android.test.NativeResourceSupport.configure(apks.toArray(Path[]::new));
  check(actualResources.getString(0x7f010000).equals("English value"));
  {
   var loader=maclauncher.android.framework.HostDexFiles.application(converted,apks,work,SourceApksProbe.class.getClassLoader());check(loader instanceof dalvik.system.PathClassLoader);
   var found=loader.getResource("owned/split.txt");check(found!=null&&found.toString().contains("split.apk"));var connection=found.openConnection();connection.setUseCaches(false);try(var in=connection.getInputStream()){check(Arrays.equals(in.readAllBytes(),new byte[]{1,2,3,4}));}
   var entries=java.util.Collections.list(loader.getResources("resources.arsc"));// Source APKs come first, in validated order; parent framework resources follow.
   if(!(entries.size()>=2&&entries.get(0).toString().contains("base.apk")&&entries.get(1).toString().contains("split.apk")&&entries.stream().skip(2).noneMatch(entry->entry.toString().contains("/files/"))))throw new AssertionError("resources.arsc order "+entries);checks++;
  }
  maclauncher.android.framework.FrameworkResources.shutdown();
  Files.move(other,root.resolve("released.apk"));check(Files.deleteIfExists(root.resolve("released.apk")));
  System.out.println("PASS source APK bounds, canonical identity, aliases and resource/classloader agreement "+checks);
 }
}
