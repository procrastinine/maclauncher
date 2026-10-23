package maclauncher.android;

import android.app.*;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.res.CompatibilityInfo;
import dalvik.system.PathClassLoader;
import java.nio.file.*;
import java.util.*;
import java.util.jar.*;
import maclauncher.android.framework.*;

/** The original LoadedApk and ContextImpl use ApplicationLoaders' default boot parent. */
public final class PackageContextLoaderProbe {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]).toRealPath(),dex=Path.of(args[1]),data=Files.createDirectories(Path.of(args[2]));
  HostFilesystem.configure(runtime,data,data,data,"owned.packages");
  System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
  System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(runtime.resolve("native/libnativebinding.dylib").toString());
  HostProcessIdentity.initializeIds();
  JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
  Path apk=data.resolve("package.apk");SyntheticResources.locales(apk,new String[]{""},new String[]{"Package"});
  maclauncher.android.fixture.PackageManifest.add(apk,"package");
  try(var zip=FileSystems.newFileSystem(apk)){Files.copy(dex,zip.getPath("/classes.dex"));}
  Path split=data.resolve("feature.apk"),converted=data.resolve("converted.jar");
  try(var zip=new java.util.zip.ZipOutputStream(Files.newOutputStream(split))){zip.putNextEntry(new java.util.zip.ZipEntry("classes.dex"));Files.copy(Path.of(args[3]),zip);zip.closeEntry();}
  Process conversion=new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-cp",args[4],"io.github.kksimp.dex2jvm.ConvertApkSet",runtime.resolve("android-api-metadata.jar").toString(),converted.toString(),apk.toString(),split.toString()).inheritIO().start();
  check(conversion.waitFor()==0,"package conversion");
  HostDexFiles.installed(converted,List.of(apk,split));
  FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
  ApplicationInfo info=new ApplicationInfo();info.packageName="owned.packages";info.sourceDir=info.publicSourceDir=apk.toString();info.dataDir=info.deviceProtectedDataDir=info.credentialProtectedDataDir=data.toString();info.nativeLibraryDir=data.toString();info.flags=ApplicationInfo.FLAG_HAS_CODE;info.targetSdkVersion=28;info.uid=android.os.Process.myUid();info.appComponentFactory="fixture.packagecontext.Factory";
  var loop=HostLooper.main();
  try{
   LoadedApk loaded=new LoadedApk(null,info,CompatibilityInfo.DEFAULT_COMPATIBILITY_INFO,null,false,true,false);
   ClassLoader loader=loaded.getClassLoader();
   // DynamicDex is deliberately not configured yet. These classes must come
   // from preparation while original LoadedApk owns their definitions.
   check(loaded.getAppFactory().getClass().getName().equals(info.appComponentFactory),"original LoadedApk instantiated DEX component factory");
   var create=Class.forName("android.app.ContextImpl").getDeclaredMethod("createAppContext",ActivityThread.class,LoadedApk.class);create.setAccessible(true);
   var constructor=ActivityThread.class.getDeclaredConstructor();constructor.setAccessible(true);
   Context context=(Context)create.invoke(null,constructor.newInstance(),loaded);
   check(context.getClassLoader()==loader,"original ContextImpl uses its package defining loader");
   check(loader.loadClass(info.appComponentFactory).getClassLoader()==loader,"factory retains package class identity");
   for(Class<?> framework:List.of(AppComponentFactory.class,Context.class,android.os.Bundle.class,android.view.View.class))check(loader.loadClass(framework.getName())==framework,"complete framework identity: "+framework);
   try{loader.loadClass("fixture.Value");throw new AssertionError("base APK exposed a feature split class");}catch(ClassNotFoundException expected){}
   ((PathClassLoader)loader).addDexPath(split.toString());
   check((int)loader.loadClass("fixture.Value").getMethod("answer").invoke(null)==42,"feature split retains prepared code and original order");
   var independent=new PathClassLoader(apk+java.io.File.pathSeparator+split,loader.getParent());
   check(independent.loadClass(info.appComponentFactory)!=loader.loadClass(info.appComponentFactory),"prepared bytes do not share defining loaders");
   ClassLoader delegate=new ClassLoader(loader.getParent()){};
   check(HostDexFiles.parent(delegate)==delegate,"caller delegating parent preserved");
   var wrapped=new PathClassLoader(apk.toString(),delegate);
   check(wrapped.getParent()==delegate&&wrapped.loadClass(info.appComponentFactory).getConstructor().newInstance() instanceof AppComponentFactory,"wrapper retains delegation and framework superclass");
   check(wrapped.loadClass(info.appComponentFactory)!=loader.loadClass(info.appComponentFactory),"equivalent wrapper reuses bytes without sharing definitions or configuring the converter");
   DynamicDex.configure(runtime,Files.createDirectories(data.resolve("dex-cache")),runtime.resolve("android-host.jar"),PackageContextLoaderProbe.class.getClassLoader());
   ClassLoader restricted=new ClassLoader(null){};
   check(HostDexFiles.parent(restricted)==restricted,"explicit isolated parent preserved");
   try{restricted.loadClass(AppComponentFactory.class.getName());throw new AssertionError("isolated parent gained framework access");}catch(ClassNotFoundException expected){}
   var isolated=new PathClassLoader(apk.toString(),restricted);
   try{isolated.loadClass(info.appComponentFactory);throw new AssertionError("prepared code bypassed its isolated parent");}catch(ClassNotFoundException|NoClassDefFoundError expected){}
  }finally{HostDexFiles.clearInstalled();DynamicDex.hostShutdown();FrameworkResources.shutdown();HostLooper.close(loop);}
  System.out.println("PASS original package context, prepared split membership, independent definitions and custom parent delegation");
 }
}
