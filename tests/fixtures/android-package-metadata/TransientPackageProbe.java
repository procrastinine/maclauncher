package maclauncher.android.framework;
import java.nio.file.*;
import java.util.*;
import android.content.pm.*;
import android.os.*;
import org.json.*;
import maclauncher.android.fixture.RuntimeFixture;

public final class TransientPackageProbe {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static String record(String pkg,int uid,Path root,Path data)throws Exception{
  return new JSONArray().put(new JSONObject().put("packageName",pkg).put("uid",uid)
   .put("sourceApks",new JSONArray().put(root.resolve("base.apk").toString()))
   .put("preparedRoot",root.toString()).put("convertedJar",root.resolve("classes.jar").toString()).put("dataRoot",data.toString()).put("nativeRoot",data.resolve("lib/arm64-v8a").toString())
   .put("firstInstallTime",1).put("lastUpdateTime",2)).toString();
 }
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]),data=Path.of(args[1]),ownApk=Path.of(args[2]);var loop=RuntimeFixture.initialize(args[0],args[1]);
  String own="org.maclauncher.metadata.fixture";HostContext.hostPackage(own,"1",1);HostContext.hostApplicationInfo(false,ownApk.toString(),data.toString(),data.toString(),28);
  HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(ownApk));HostPackages.inspectSources(List.of(ownApk));
  try{
   var ownState=HostPackages.hostGetPackageStateInternal(null,own);
   Path a=Files.createDirectories(data.resolve("generation-a")),b=Files.createDirectories(data.resolve("generation-b"));
   Files.copy(Path.of(args[3]),a.resolve("base.apk"));Files.copy(Path.of(args[3]),b.resolve("base.apk"));
   for(Path root:List.of(a,b))try(var empty=new java.util.jar.JarOutputStream(Files.newOutputStream(root.resolve("classes.jar")))){}
   var index=HostDexFiles.class.getDeclaredField("installations");index.setAccessible(true);
   String pkg=HostPackageParser.parseSources(List.of(a.resolve("base.apk")),data.resolve("cache")).getPackageName();int uid=11030,user=UserHandle.myUserId();
   var first=new HostBinderRpc.Peer(pkg,pkg,21001,uid);var second=new HostBinderRpc.Peer(pkg,pkg+":other",21002,uid);
   String ar=record(pkg,uid,a,data.resolve("peer-data")),br=record(pkg,uid,b,data.resolve("peer-data"));
   check(HostPackages.enrollInstalled(first,ar).equals(Set.of(a.toString())),"first canonical preparation root");
   check(HostPackages.enrollInstalled(second,br).equals(Set.of(a.toString())),"second peer retains the existing canonical row source");
   check(((Map<?,?>)index.get(null)).keySet().equals(Set.of(a.resolve("base.apk"))),"derived DEX index has only the canonical source");
   check(HostPackages.verifiedSigningDetails(pkg).getSignatures().length>0,"original verifier retains actual publisher identity");
   HostServices.retirePeer(first);
   check(HostPackages.service().getApplicationInfo(pkg,0,user).sourceDir.equals(a.resolve("base.apk").toString()),"one remaining peer preserves canonical original package");
   HostServices.retirePeer(second);
   check(HostPackages.service().getApplicationInfo(pkg,0,user)==null,"last transient retirement removes its package row");
   check(((Map<?,?>)index.get(null)).isEmpty(),"last package row retires its derived DEX source index");
   check(HostPackages.hostGetPackageStateInternal(null,own)==ownState,"own original PackageSetting is retained");
   Files.delete(a.resolve("base.apk"));
   var third=new HostBinderRpc.Peer(pkg,pkg,21003,uid);check(HostPackages.enrollInstalled(third,br).equals(Set.of(b.toString())),"new generation does not reopen retired APK source");
   HostPackages.inspectInstalled(br);HostServices.retirePeer(third);
   check(HostPackages.service().getApplicationInfo(pkg,0,user)!=null,"genuinely installed metadata survives transient peer retirement");
   System.out.println("PASS original verified package identity, two peers, canonical source lifetime, new generation and persistent rows");
  }finally{HostPackages.hostClearProviders();HostLooper.close(loop);FrameworkResources.shutdown();}
  System.exit(0);
 }
}
