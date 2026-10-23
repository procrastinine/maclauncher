import android.app.Application;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Looper;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.*;

/** Actual APK metadata and the game's original PlayCore client; no SDK substitutes. */
public final class InstalledAssetPackProbe {
 public static void main(String[] args)throws Exception {
  Path runtime=Path.of(args[0]).toRealPath(),data=Files.createDirectories(Path.of(args[2])).toRealPath();
  var launch=new org.json.JSONObject(Files.readString(Path.of(args[1])));String pkg=launch.getString("packageName");
  Path files=Files.createDirectories(data.resolve("files")),cache=Files.createDirectories(data.resolve("cache"));
  HostFilesystem.configure(runtime,data,files,cache,pkg);
  for(String kind:List.of("bridge","graphics","audio"))System.setProperty("klepton."+kind,runtime.resolve("native/libklepton-"+(kind.equals("bridge")?"jvm":kind)+".dylib").toString());
  System.load(System.getProperty("klepton.bridge"));System.load(runtime.resolve("native/libnativebinding.dylib").toString());
  JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();HostStorageService.install();
  List<Path> sources=new ArrayList<>();var names=launch.getJSONArray("sourceApks");for(int i=0;i<names.length();i++)sources.add(Path.of(launch.getString("sourceApk")).getParent().resolve(names.getString(i)).toRealPath());
  FrameworkResources.configure(runtime.resolve("android-framework.jar"),sources);
  HostContext.hostPackage(pkg,launch.getString("versionName"),launch.getInt("versionCode"));HostContext.hostApplicationInfo(false,sources.getFirst().toString(),data.toString(),launch.getString("nativeRoot"),35);
  HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostContext.hostFilesDirectory(files.toString());HostContext.hostCacheDirectory(cache.toString());
  ClassLoader loader=InstalledAssetPackProbe.class.getClassLoader();HostContext.hostClassLoader(loader);HostPackages.inspectSources(sources);
  Looper loop=HostLooper.main();HostDisplay.hostPublish(1,640,384,60);HostApplication.prepare(loader);Context context=HostApplication.applicationContext();Application app=new Application();HostApplication.attach(app,context);HostApplication.create(app);
  try {
   var info=context.getPackageManager().getPackageInfo(pkg,PackageManager.GET_META_DATA);
   System.out.println("PACKAGE splits="+Arrays.toString(info.splitNames)+" paths="+Arrays.toString(info.applicationInfo.splitSourceDirs));
   Class<?> factory=Class.forName("com.google.android.play.core.assetpacks.AssetPackManagerFactory"),api=Class.forName("com.google.android.play.core.assetpacks.AssetPackManager"),location=Class.forName("com.google.android.play.core.assetpacks.AssetPackLocation"),assetLocation=Class.forName("com.google.android.play.core.assetpacks.AssetLocation");
   Object manager=factory.getMethod("getInstance",Context.class).invoke(null,context),pack=api.getMethod("getPackLocation",String.class).invoke(manager,"UnityDataAssetPack");
   System.out.println("PACK="+pack);if(pack==null)throw new AssertionError("Installed asset pack was not discovered by original PlayCore");
   System.out.println("STORAGE="+location.getMethod("packStorageMethod").invoke(pack)+" ASSETS="+location.getMethod("assetsPath").invoke(pack));
   Object asset=api.getMethod("getAssetLocation",String.class,String.class).invoke(manager,"UnityDataAssetPack","bin/Data/datapack.unity3d");
   System.out.println("ASSET="+asset);if(asset==null)throw new AssertionError("Original PlayCore did not locate installed datapack bytes");
   String file=(String)assetLocation.getMethod("path").invoke(asset);long offset=(Long)assetLocation.getMethod("offset").invoke(asset),size=(Long)assetLocation.getMethod("size").invoke(asset);
   try(var input=new java.io.RandomAccessFile(file,"r")){input.seek(offset);byte[] signature=new byte[8];input.readFully(signature);if(!new String(signature,java.nio.charset.StandardCharsets.US_ASCII).startsWith("UnityFS"))throw new AssertionError("Asset points outside Unity bundle");System.out.println("PASS original PlayCore locates real installed UnityDataAssetPack bundle; bytes="+size);}
  } finally {HostApplication.shutdown();HostDisplayEvents.hostShutdown();HostDisplay.hostShutdown();HostDisplay.hostRemove();FrameworkResources.shutdown();HostLooper.close(loop);}
  System.exit(0);
 }
}
