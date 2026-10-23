package maclauncher.android;
import android.content.pm.*;
import android.os.*;
import com.android.server.pm.dex.*;
import java.lang.reflect.Field;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.*;

public final class DexLoadProbe {
 static void check(boolean value,String text){if(!value)throw new AssertionError(text);}
 static Object field(Object owner,String name)throws Exception{Field field=owner.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(owner);}
 @SuppressWarnings("unchecked") static Map<String,Object> uses(HostDexReports manager,String name)throws Exception{return (Map<String,Object>)field(manager.getPackageUseInfoOrDefault(name),"mDexUseInfoMap");}
 static HostDexReports reports()throws Exception{Field field=HostPackages.class.getDeclaredField("dexManager");field.setAccessible(true);return (HostDexReports)field.get(null);}
 public static void main(String[] args){try{run(args);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
 private static void run(String[] args)throws Exception{
  Looper.prepareMainLooper();
  for(String component:List.of("bridge","graphics","audio"))System.setProperty("klepton."+component,"/system/lib64/libart-platform.so");
  System.load("/system/lib64/libart-authority.so");System.load("/system/lib64/libart-rpc.so");System.load("/system/lib64/libart-platform.so");
  HostDigests.initialize();Field service=ServiceManager.class.getDeclaredField("sServiceManager");service.setAccessible(true);service.set(null,HostServices.manager());
  String pkg="org.maclauncher.metadata.fixture";Path apk=Path.of(args[0]),data=Path.of("/data/user/0/"+pkg);Files.createDirectories(data.resolve("files"));Files.createDirectories(data.resolve("cache"));
  HostFilesystem.configureAndroid(data,data.resolve("files"),data.resolve("cache"),pkg);HostContext.hostPackage(pkg,"control",1);HostContext.hostApplicationInfo(ApplicationInfo.FLAG_HAS_CODE,apk.toString(),data.toString(),data.toString(),28);HostContext.hostApplicationNativeAbi("arm64-v8a");HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
  FrameworkResources.configure(Path.of("/system/framework/framework-res.apk"),List.of(apk));var compatibility=Class.forName("maclauncher.android.ArtActivity").getDeclaredMethod("compatibilityDirectories");compatibility.setAccessible(true);com.android.server.compat.HostPlatformCompat.prepare((List<Path>)compatibility.invoke(null));HostPackages.inspectSources(List.of(apk),false);
  var state=(com.android.server.pm.PackageSetting)HostPackages.hostGetPackageStateInternal(null,pkg);
  state.setPageSizeAppCompatFlags(ApplicationInfo.PAGE_SIZE_APP_COMPAT_FLAG_SETTINGS_OVERRIDE_DISABLED);
  check(!HostPackages.hostPageSizeCompatibility(ApplicationInfo.PAGE_SIZE_APP_COMPAT_FLAG_ELF_NOT_ALIGNED),"original explicit settings disable remains decisive");
  check((state.getPageSizeAppCompatFlags()&ApplicationInfo.PAGE_SIZE_APP_COMPAT_FLAG_SETTINGS_OVERRIDE_DISABLED)!=0,"settings disable flag retained");
  state.setPageSizeAppCompatFlags(ApplicationInfo.PAGE_SIZE_APP_COMPAT_FLAG_SETTINGS_OVERRIDE_ENABLED);
  check(HostPackages.hostPageSizeCompatibility(ApplicationInfo.PAGE_SIZE_APP_COMPAT_FLAG_UNDEFINED),"original explicit settings enable survives aligned scan");
  var parsed=state.getPkg();Field manifest=parsed.getClass().getDeclaredField("mPageSizeAppCompatFlags");manifest.setAccessible(true);int originalFlags=manifest.getInt(parsed);
  manifest.setInt(parsed,ApplicationInfo.PAGE_SIZE_APP_COMPAT_FLAG_MANIFEST_OVERRIDE_DISABLED);state.setPageSizeAppCompatFlags(0);
  check(!HostPackages.hostPageSizeCompatibility(ApplicationInfo.PAGE_SIZE_APP_COMPAT_FLAG_ELF_NOT_ALIGNED),"original explicit manifest disable remains decisive");
  manifest.setInt(parsed,originalFlags);state.setPageSizeAppCompatFlags(0);
  HostPackages.service().notifyDexLoad(pkg,Map.of(apk.toString(),"PCL[]"),"arm64");reports().writeNow();
  check(Files.size(data.resolve("system/dex/package-dex-usage.list"))>0,"empty original usage state still serializes its format header");
  Path secondary=data.resolve("cache/secondary.dex");Files.copy(Path.of(args[1]),secondary,StandardCopyOption.REPLACE_EXISTING);
  HostPackages.service().notifyDexLoad(pkg,Map.of(secondary.toString(),"PCL[]"),"arm64");
  var manager=reports();var usage=uses(manager,pkg).get(secondary.toString());
  check(usage!=null&&field(usage,"mClassLoaderContext").equals("PCL[]")&&((Set<?>)field(usage,"mLoaderIsas")).contains("arm64"),"original ART validator and usage metadata retain actual secondary load");
  check(!((Boolean)field(usage,"mIsUsedByOtherApps")),"own secondary load is not attributed to another app");
  HostPackages.service().notifyDexLoad(pkg,Map.of(apk.toString(),"PCL[]"),"arm64");check(!manager.getPackageUseInfoOrDefault(pkg).isAnyCodePathUsedByOtherApps(),"no invented application-Dex cross-package usage");
  HostPackages.service().notifyDexLoad(pkg,Map.of(data.resolve("cache/invalid.dex").toString(),"invalid-context"),"arm64");
  HostPackages.service().notifyDexLoad(pkg,Map.of(data.resolve("cache/unsupported.dex").toString(),"PCL[]"),"unsupported-isa");
  HostPackages.service().notifyDexLoad(pkg,Map.of("/data/user/0/unowned/cache/unknown.dex","PCL[]"),"arm64");
  check(uses(manager,pkg).size()==1,"original invalid context, ISA and unowned-path behavior");
  try{HostPackages.service().notifyDexLoad("different.package",Map.of(secondary.toString(),"PCL[]"),"arm64");throw new AssertionError("caller package spoof admitted");}catch(SecurityException expected){}
  var identity=(com.android.internal.pm.parsing.pkg.ParsedPackage)parsed;int uid=android.os.Process.myUid();identity.setUid(uid+1);
  try{try{HostPackages.service().notifyDexLoad(pkg,Map.of(secondary.toString(),"PCL[]"),"arm64");throw new AssertionError("another installed UID admitted");}catch(SecurityException expected){}}
  finally{identity.setUid(uid);}
  ApplicationInfo peer=new ApplicationInfo();peer.packageName="fixture.peer";peer.uid=10018;peer.sourceDir="/data/app/fixture.peer/base.apk";peer.dataDir="/data/user/0/fixture.peer";peer.credentialProtectedDataDir=peer.dataDir;peer.deviceProtectedDataDir="/data/user_de/0/fixture.peer";PackageInfo info=new PackageInfo();info.packageName=peer.packageName;info.applicationInfo=peer;manager.notifyPackageInstalled(info,0);
  var loading=HostContext.hostApplicationInfoSnapshot();String peerDex=peer.dataDir+"/cache/secondary.dex";manager.notifyDexLoad(loading,Map.of(peerDex,"PCL[]"),"arm64",0,false);check((Boolean)field(uses(manager,peer.packageName).get(peerDex),"mIsUsedByOtherApps"),"original cross-package metadata");manager.retirePackage(peer.packageName);manager.notifyDexLoad(loading,Map.of(peerDex,"PCL[]"),"arm64",0,false);check(uses(manager,peer.packageName).isEmpty(),"retired package cannot leave stale code ownership");
  manager.writeNow();check(new String(Files.readAllBytes(data.resolve("system/dex/package-dex-usage.list")),java.nio.charset.StandardCharsets.UTF_8).contains(secondary.toString()),"original usage serialization in private installation storage");check(new String(Files.readAllBytes(data.resolve("system/dex/package-dcl.list")),java.nio.charset.StandardCharsets.UTF_8).contains(secondary.toString()),"original dynamic-code serialization in private installation storage");
  HostPackages.hostClearProviders();HostPackages.inspectSources(List.of(apk),false);HostPackages.service().notifyDexLoad(pkg,Map.of(apk.toString(),"PCL[]"),"arm64");check(uses(reports(),pkg).containsKey(secondary.toString()),"original persisted usage restores on service recreation");
  Path finalDex=data.resolve("cache/final-retirement.dex");Files.copy(Path.of(args[1]),finalDex,StandardCopyOption.REPLACE_EXISTING);
  HostPackages.service().notifyDexLoad(pkg,Map.of(finalDex.toString(),"PCL[]"),"arm64");
  Throwable retirement=HostContextServices.retireApplication(null,null);if(retirement!=null)throw new AssertionError("original application retirement",retirement);
  check(new String(Files.readAllBytes(data.resolve("system/dex/package-dex-usage.list")),java.nio.charset.StandardCharsets.UTF_8).contains(finalDex.toString()),"final application retirement persists a fresh usage record");
  check(new String(Files.readAllBytes(data.resolve("system/dex/package-dcl.list")),java.nio.charset.StandardCharsets.UTF_8).contains(finalDex.toString()),"final application retirement persists a fresh dynamic-code record");
  FrameworkResources.shutdown();System.out.println("PASS ART original notifyDexLoad validation, caller identity, actual ownership, private persistence and retirement");System.exit(0);
 }
}
