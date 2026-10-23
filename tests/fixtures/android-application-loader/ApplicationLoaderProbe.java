import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import maclauncher.android.framework.*;
public final class ApplicationLoaderProbe {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static Path apk(Path file,String value)throws Exception{try(var zip=new ZipOutputStream(Files.newOutputStream(file))){for(var entry:Map.of("owned/data.txt",value,"owned/order.txt",value,"AndroidManifest.xml",value+" manifest").entrySet()){zip.putNextEntry(new ZipEntry(entry.getKey()));zip.write(entry.getValue().getBytes(java.nio.charset.StandardCharsets.UTF_8));zip.closeEntry();}}return file;}
 static String contents(java.net.URL resource)throws Exception{check(resource!=null,"resource exists");try(var input=resource.openStream()){return new String(input.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8);}}
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]),root=Path.of(args[1]),converted=Path.of(args[2]);
  HostFilesystem.configure(runtime,root,root,root,"owned.application");
  System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(runtime.resolve("native/libnativebinding.dylib").toString());
  JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
  Path base=apk(root.resolve("base.apk"),"base"),split=apk(root.resolve("split.apk"),"split");
  Path library=Files.write(root.resolve("libowned.so"),new byte[]{1});
  var loader=HostDexFiles.application(converted,List.of(base,split),root,ApplicationLoaderProbe.class.getClassLoader());
  check(loader.getClass().getSuperclass()==dalvik.system.PathClassLoader.class,"resource adapter directly inherits the original application loader");
  check(((dalvik.system.BaseDexClassLoader)loader).findLibrary("owned").equals(library.toRealPath().toString()),"original native path search");
  check(loader.findLibrary("missing")==null,"missing native library");
  Class<?> entry=loader.loadClass("fixture.Value");check(entry.getClassLoader()==loader,"actual JVM defining owner");check((int)entry.getMethod("answer").invoke(null)==7,"prepared application bytecode");
  check(loader.loadClass("ApplicationLoaderProbe")==ApplicationLoaderProbe.class,"duplicate application class retains parent-first resolution");
  check(loader.loadClass("dalvik/system/PathClassLoader")==dalvik.system.PathClassLoader.class,"Android SDK internal platform name");
  check(loader.loadClass("dalvik/system/InMemoryDexClassLoader")==dalvik.system.InMemoryDexClassLoader.class,"Android SDK internal memory loader name");
  check(loader.loadClass("fixture/Value")==entry,"internal application name retains defining identity");
  check(loader.getParent().loadClass("java/lang/String")==String.class,"platform delegation preserves JVM identity");
  check(HostDexFiles.parent(loader)==loader,"custom parent identity is preserved");
  try{loader.loadClass("missing/ActualAbsent");throw new AssertionError("missing class accepted");}catch(ClassNotFoundException expected){}
  var primitive=Map.of("[Z",boolean[].class,"[B",byte[].class,"[C",char[].class,"[S",short[].class,"[I",int[].class,"[J",long[].class,"[F",float[].class,"[D",double[].class);
  for(var array:primitive.entrySet())check(loader.loadClass(array.getKey())==array.getValue(),"primitive array "+array.getKey());
  check(loader.loadClass("[[B")==byte[][].class,"multidimensional primitive array");
  check(loader.loadClass("[Ljava/lang/String;")==String[].class,"internal reference array");
  check(loader.loadClass("[[Ljava.lang.String;")==String[][].class,"dotted multidimensional reference array");
  check(loader.getParent().loadClass("[B")==byte[].class,"Android boot-parent array boundary");
  check(loader.getParent().loadClass("[Landroid/os/Bundle;")==android.os.Bundle[].class,"boot framework array identity");
  System.clearProperty("fixture.array.initialized");
  Class<?> componentArray=loader.loadClass("[[Lfixture/ArrayComponent;"),component=loader.loadClass("fixture.ArrayComponent");
  check(componentArray.getComponentType().getComponentType()==component,"array retains actual application component owner");
  check(component.getClassLoader()==loader&&System.getProperty("fixture.array.initialized")==null,"array/component loading does not initialize the component");
  var sibling=HostDexFiles.application(converted,List.of(base,split),root,ApplicationLoaderProbe.class.getClassLoader());
  check(sibling.loadClass("[[Lfixture.ArrayComponent;")!=componentArray,"separate defining loaders retain distinct array identities");
  var shared=new dalvik.system.PathClassLoader("",root.toString(),null,new ClassLoader[]{loader},null);
  var after=new dalvik.system.PathClassLoader("",root.toString(),null,null,new ClassLoader[]{loader});
  var delegateLast=new dalvik.system.DelegateLastClassLoader("",root.toString(),loader);
  for(var delegated:List.of(shared,after,delegateLast)){
   check(delegated.loadClass("fixture/ArrayComponent")==component,"original shared/delegate-last component search");
   check(delegated.loadClass("[[Lfixture.ArrayComponent;")==componentArray,"array uses original shared/delegate-last ownership");
   check(delegated.loadClass("[B")==byte[].class,"array entry on original loader override");
  }
  for(String invalid:List.of("[V","[[","[I;","[Ljava.lang.String","[L;","[Lmissing/ActualAbsent;","int","")){
   try{loader.loadClass(invalid);throw new AssertionError("invalid/absent descriptor accepted: "+invalid);}catch(ClassNotFoundException expected){}
  }
  check(loader.isRegisteredAsParallelCapable(),"array boundary retains parallel-capable loader");
  try(var workers=java.util.concurrent.Executors.newFixedThreadPool(4)){
   var pending=new ArrayList<java.util.concurrent.Future<Class<?>>>();
   for(int i=0;i<32;i++)pending.add(workers.submit(()->loader.loadClass("[[Lfixture/ArrayComponent;")));
   for(var item:pending)check(item.get()==componentArray,"concurrent array loads retain one JVM identity");
  }
  check(System.getProperty("fixture.array.initialized")==null,"parallel array loading remains noninitializing");
  Class.forName(component.getName(),true,loader);check("yes".equals(System.getProperty("fixture.array.initialized")),"explicit initialization still runs the original initializer");
  System.out.println("PASS Android array descriptors, original delegation, noninitialization and defining identity");
  var resources=Collections.list(loader.getResources("owned/data.txt"));check(resources.size()==3&&resources.get(0).toString().contains("base.apk")&&resources.get(1).toString().contains("split.apk")&&resources.get(2).toString().contains("/parent/"),"original APK order precedes parent resources");
  var ordered=new ArrayList<String>();for(var resource:Collections.list(loader.getResources("owned/order.txt")))ordered.add(contents(resource));check(ordered.equals(List.of("own","base","split","parent")),"converted/base/split/parent resource enumeration");
  check(contents(entry.getResource("/AndroidManifest.xml")).equals("base manifest"),"Class.getResource identifies the owning base APK before the framework manifest");
  var manifests=Collections.list(loader.getResources("AndroidManifest.xml"));check(contents(manifests.get(0)).equals("base manifest")&&contents(manifests.get(1)).equals("split manifest"),"manifest enumeration preserves base/split order");
  check(manifests.subList(2,manifests.size()).equals(Collections.list(loader.getParent().getResources("AndroidManifest.xml"))),"all original parent resources remain available after application resources");
  check(contents(loader.getResource("parent-only.txt")).equals("parent"),"missing application resource falls back to parent");
  check(loader.getResource("missing/resource.txt")==null&&!loader.getResources("missing/resource.txt").hasMoreElements(),"missing resources remain absent");
  try(var input=loader.getResourceAsStream("owned/data.txt")){check(new String(input.readAllBytes(),java.nio.charset.StandardCharsets.UTF_8).equals("base"),"original APK resource bytes");}
  check(HostDexFiles.headers(loader).equals(List.of(converted.toRealPath())),"prepared converter header identity");
  // LoadedApk uses this complete original factory when another installed
  // package supplies executable code (including Dynamite provider contexts).
  var packageLoader=com.android.internal.os.ClassLoaderFactory.createClassLoader(
      "",root.toString(),root.toString(),loader,36,false,null);
  check(packageLoader.getClass()==dalvik.system.PathClassLoader.class,"package factory retains the original loader");
  check(packageLoader.getParent()==loader,"package factory retains its actual parent");
  check(packageLoader.loadClass("fixture.Value")==entry,"package delegation preserves class ownership");
  check(Path.of(((dalvik.system.BaseDexClassLoader)packageLoader).findLibrary("owned")).toRealPath().equals(library.toRealPath()),"package namespace retains original native search");
  System.out.println("PASS original application PathClassLoader, defining owner, prepared code, APK resources and native search");
 }
}
