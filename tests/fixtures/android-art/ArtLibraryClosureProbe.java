package maclauncher.android;
import android.content.pm.ApplicationInfo;
import dalvik.system.PathClassLoader;
import java.nio.file.*;
import java.util.*;
import java.util.jar.JarFile;
import maclauncher.android.framework.*;
import org.json.*;
public final class ArtLibraryClosureProbe {
 public static void main(String[] args){try{run(args);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
 private static void run(String[] args)throws Exception{
  android.os.Looper.prepareMainLooper();System.load("/system/lib64/libart-authority.so");System.load("/system/lib64/libart-rpc.so");System.load("/system/lib64/libart-platform.so");HostDigests.initialize();var service=android.os.ServiceManager.class.getDeclaredField("sServiceManager");service.setAccessible(true);service.set(null,HostServices.manager());
  JSONObject config=new JSONObject(new String(Files.readAllBytes(Path.of(args[0])),java.nio.charset.StandardCharsets.UTF_8));String pkg=config.getString("packageName");
  Path data=Path.of("/data/user/0/"+pkg);Files.createDirectories(data.resolve("files"));Files.createDirectories(data.resolve("cache"));
  HostFilesystem.configureAndroid(data,data.resolve("files"),data.resolve("cache"),pkg);
  HostContext.hostPackage(pkg,"control",1);HostContext.hostApplicationInfo(ApplicationInfo.FLAG_HAS_CODE,config.getJSONArray("sourceApks").getString(0),data.toString(),config.getString("nativeRoot"),36);HostContext.hostApplicationNativeAbi("arm64-v8a");HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
  var sources=new ArrayList<Path>();for(int i=0;i<config.getJSONArray("sourceApks").length();i++)sources.add(Path.of(config.getJSONArray("sourceApks").getString(i)));
  FrameworkResources.configure(Path.of("/system/framework/framework-res.apk"),sources);var configuration=Class.forName("maclauncher.android.ArtActivity").getDeclaredMethod("compatibilityDirectories");configuration.setAccessible(true);com.android.server.compat.HostPlatformCompat.prepare((List<Path>)configuration.invoke(null));HostPackages.inspectSources(sources);
  for(Path source:sources)try(JarFile archive=new JarFile(source.toFile())){if(archive.getEntry("AndroidManifest.xml")==null)throw new AssertionError("Original split resource archive differs");}
  System.out.println("PASS original installed base and split APKs readable through Java JarFile with unprivileged app identity");
  JSONObject provider=config.getJSONObject("provider");HostPackages.inspectInstalled(new JSONArray().put(provider).toString());
  ArtLibraryCompatibility.configure(HostContext.hostApplicationInfoSnapshot());
  PathClassLoader loader=new PathClassLoader(provider.getJSONArray("sourceApks").getString(0),provider.getString("nativeRoot"),ArtLibraryClosureProbe.class.getClassLoader());
  Class<?> conscrypt=Class.forName("com.google.android.gms.org.conscrypt.Conscrypt",true,loader);
  Object crypto=conscrypt.getMethod("newProvider").invoke(null);
  if(!(crypto instanceof java.security.Provider p)||!p.getName().contains("Conscrypt"))throw new AssertionError("Original Conscrypt provider unavailable: "+crypto);
  javax.net.ssl.SSLContext ssl=javax.net.ssl.SSLContext.getInstance("TLS",(java.security.Provider)crypto);ssl.init(null,null,null);if(ssl.createSSLEngine()==null)throw new AssertionError("Original TLS engine unavailable");
  System.out.println("PASS admitted original 4KB Conscrypt JNI loads, registers provider and creates TLS engine without network");System.exit(0);
 }
}
