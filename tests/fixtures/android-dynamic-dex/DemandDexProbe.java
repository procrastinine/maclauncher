import dalvik.system.*;
import maclauncher.android.DynamicDex;
import maclauncher.android.framework.*;
import maclauncher.android.bridge.GuestNativeLoader;
import java.io.*;
import java.nio.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import java.util.concurrent.*;
import java.util.concurrent.locks.ReentrantLock;

public final class DemandDexProbe {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static void apk(Path file,Path dex)throws Exception{if(Files.exists(file))return;try(var zip=new ZipOutputStream(Files.newOutputStream(file))){zip.putNextEntry(new ZipEntry("classes.dex"));Files.copy(dex,zip);zip.closeEntry();zip.putNextEntry(new ZipEntry("asset.txt"));zip.write(42);zip.closeEntry();}}
 static int answer(ClassLoader loader)throws Exception{return (int)loader.loadClass("fixture.Value").getMethod("answer").invoke(null);}
 static Object session()throws Exception{var field=DynamicDex.class.getDeclaredField("current");field.setAccessible(true);return field.get(null);}
 static ReentrantLock lock(Object session,String name)throws Exception{var field=session.getClass().getDeclaredField(name);field.setAccessible(true);return(ReentrantLock)field.get(session);}
 static void independentPublication(ClassLoader loader)throws Exception{
  Object owner=session();ReentrantLock lease=lock(owner,"publicationLock");CountDownLatch held=new CountDownLatch(1),release=new CountDownLatch(1);
  Thread publisher=new Thread(()->{lease.lock();try{held.countDown();release.await();}catch(InterruptedException error){Thread.currentThread().interrupt();}finally{lease.unlock();}},"Fixture slow cache publisher");publisher.start();
  FutureTask<Integer> lookup=new FutureTask<>(()->answer(loader));Thread caller=new Thread(lookup,"Fixture class request");
  try{check(held.await(5,TimeUnit.SECONDS),"publisher lease acquired");caller.start();check(lookup.get(10,TimeUnit.SECONDS)==42,"class execution is independent of optional persistence and maintenance");}
  finally{release.countDown();publisher.join(5000);caller.join(5000);}
 }
 static void awaitPersistence()throws Exception{
  Object owner=session();ReentrantLock lock=lock(owner,"lock");var field=owner.getClass().getDeclaredField("queuedKeys");field.setAccessible(true);
  long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(10);
  for(;;){lock.lock();try{if(((Set<?>)field.get(owner)).isEmpty())return;}finally{lock.unlock();}if(System.nanoTime()>until)throw new AssertionError("optional cache writer did not finish");Thread.sleep(2);}
 }
 static void writerDoesNotOwnByteCache()throws Exception{
  Object owner=session();ReentrantLock cache=lock(owner,"lock");
  var publish=owner.getClass().getDeclaredMethod("publishClass",String.class,String.class,Map.class,String.class,byte[].class);publish.setAccessible(true);
  String key="f".repeat(64);Object artifact=publish.invoke(owner,key,key,Map.of(),"fixture/optional/Publication",new byte[]{1,2,3});
  var remember=owner.getClass().getDeclaredMethod("remember",String.class,artifact.getClass());remember.setAccessible(true);
  var release=owner.getClass().getDeclaredMethod("release",artifact.getClass());release.setAccessible(true);
  var queued=owner.getClass().getDeclaredField("queuedKeys");queued.setAccessible(true);
  cache.lock();try{
   remember.invoke(owner,key,artifact);long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
   while(((Set<?>)queued.get(owner)).contains(key)){if(System.nanoTime()>until)throw new AssertionError("optional writer waited for byte-cache map lock");Thread.sleep(2);}
  }finally{cache.unlock();release.invoke(owner,artifact);}
 }
 static void independentWarmBytes(Path index,List<Path> sources,ClassLoader parent)throws Exception{
  try(var module=DynamicDex.demand(index,sources,parent,null)){
   check(module.classBytes("fixture.Value")!=null,"warm demand bytes");
   var field=module.getClass().getDeclaredField("demand");field.setAccessible(true);Object demand=field.get(module);
   var guard=demand.getClass().getDeclaredField("conversion");guard.setAccessible(true);Object protocol=guard.get(demand);
   CountDownLatch held=new CountDownLatch(1),release=new CountDownLatch(1);
   Thread converter=new Thread(()->{synchronized(protocol){held.countDown();try{release.await();}catch(InterruptedException error){Thread.currentThread().interrupt();}}},"Fixture paused cold converter");converter.start();
   FutureTask<byte[]> warm=new FutureTask<>(()->module.classBytes("fixture.Value"));Thread caller=new Thread(warm,"Fixture warm class request");
   try{check(held.await(5,TimeUnit.SECONDS),"cold converter paused");caller.start();check(warm.get(3,TimeUnit.SECONDS)!=null,"warm bytes bypass an unrelated cold conversion");}
   finally{release.countDown();converter.join(5000);caller.join(5000);}
  }
 }
 static void independentClassDefinition(ClassLoader loader)throws Exception{
  check(loader.isRegisteredAsParallelCapable(),"the complete original superclass hierarchy registered for per-class locks");
  CountDownLatch held=new CountDownLatch(1),release=new CountDownLatch(1);
  Thread unrelated=new Thread(()->{synchronized(loader){held.countDown();try{release.await();}catch(InterruptedException error){Thread.currentThread().interrupt();}}},"Fixture unrelated loader monitor");unrelated.start();
  FutureTask<Integer> load=new FutureTask<>(()->answer(loader));Thread caller=new Thread(load,"Fixture independent class definition");
  try{check(held.await(5,TimeUnit.SECONDS),"unrelated loader monitor held");caller.start();check(load.get(10,TimeUnit.SECONDS)==42,"cold definition uses its class-name lock, not the loader monitor");}
  finally{release.countDown();unrelated.join(5000);caller.join(5000);}
 }
 static void sharedHeaderSnapshots()throws Exception{
  Object owner=session();var type=Class.forName("maclauncher.android.DynamicDex$HeaderFacts");
  var copy=type.getDeclaredMethod("copy",Map.class);copy.setAccessible(true);
  var source=new TreeMap<String,byte[]>();for(int i=0;i<5000;i++)source.put("fixture/parent/Type"+i,new byte[32]);
  Map<?,?> facts=(Map<?,?>)copy.invoke(null,source);source.clear();check(facts.size()==5000,"snapshot remains immutable after the converter adds or clears facts");
  var publish=owner.getClass().getDeclaredMethod("publishClass",String.class,String.class,Map.class,String.class,byte[].class);publish.setAccessible(true);
  var bytes=owner.getClass().getDeclaredField("cacheBytes");bytes.setAccessible(true);
  long before=bytes.getLong(owner);Object first=publish.invoke(owner,"c".repeat(64),"a".repeat(64),facts,"fixture/optional/One",new byte[]{1,2,3});long once=bytes.getLong(owner);
  Object second=publish.invoke(owner,"d".repeat(64),"a".repeat(64),facts,"fixture/optional/Two",new byte[]{1,2,3});long twice=bytes.getLong(owner);
  check(once-before>5000*128L&&twice-once==131,"shared hierarchy metadata is charged once, with bounded per-class bytes");
  var headers=first.getClass().getDeclaredField("parentHeaders");headers.setAccessible(true);check(headers.get(first)==headers.get(second),"classes retain one immutable hierarchy snapshot");
  var release=owner.getClass().getDeclaredMethod("release",first.getClass());release.setAccessible(true);release.invoke(owner,first);release.invoke(owner,second);
 }
 static void legacyContextNames(Path directory)throws Exception{
  int renamed=0;
  try(var entries=Files.list(directory)){for(Path entry:entries.toList()){
   String name=entry.getFileName().toString();if(!name.matches("[a-f0-9]{64}-[a-f0-9]{64}"))continue;
   var facts=new TreeMap<String,byte[]>();
   try(var input=new DataInputStream(Files.newInputStream(entry.resolve("headers")))){check(input.readInt()==1,"unchanged persistent facts format");int count=input.readInt();for(int i=0;i<count;i++)facts.put(input.readUTF(),input.readNBytes(32));}
   var digest=java.security.MessageDigest.getInstance("SHA-256");digest.update(name.substring(0,64).getBytes(java.nio.charset.StandardCharsets.UTF_8));
   for(var fact:facts.entrySet()){byte[] key=fact.getKey().getBytes(java.nio.charset.StandardCharsets.UTF_8);digest.update(ByteBuffer.allocate(4).putInt(key.length).array());digest.update(key);digest.update(fact.getValue());}
   Path legacy=directory.resolve(name.substring(0,65)+HexFormat.of().formatHex(digest.digest()));
   if(!legacy.equals(entry)&&!Files.exists(legacy)){Files.move(entry,legacy,StandardCopyOption.ATOMIC_MOVE);renamed++;}
  }}
  check(renamed>0,"cold entries were retained under the original context-digest names");
 }
 public static void main(String[] args)throws Exception{
  Path base=Path.of(args[0]).toRealPath(),tools=Path.of(args[1]).toRealPath(),data=Files.createDirectories(Path.of(args[4]));
  HostFilesystem.configure(base,data,data,data,"owned.demand");
  System.setProperty("klepton.graphics",base.resolve("native/libklepton-graphics.dylib").toString());
  System.load(base.resolve("native/libklepton-jvm.dylib").toString());System.load(base.resolve("native/libnativebinding.dylib").toString());
  JvmNativeMemory.configure(base.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
  Path one=data.resolve("base.apk"),two=data.resolve("feature.apk"),index=data.resolve("converted.jar");apk(one,Path.of(args[2]));apk(two,Path.of(args[3]));
  boolean cold=!Files.exists(index);
  if(cold){
   String cp=tools.resolve("converter-overlay.jar")+File.pathSeparator+tools.resolve("dex2jvm.jar");
   var process=new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-Dmaclauncher.dex.demand=true","-cp",cp,"io.github.kksimp.dex2jvm.ConvertApkSet",tools.resolve("android-api-metadata.jar").toString(),index.toString(),one.toString(),two.toString()).inheritIO().start();
   check(process.waitFor()==0,"indexed complete APK set");
  }
  try(var zip=new ZipFile(index.toFile())){check(zip.getEntry("META-INF/maclauncher/demand-dex")!=null,"demand index");check(zip.stream().noneMatch(e->e.getName().endsWith(".class")),"preparation did not eagerly translate classes");}
  check(DynamicDex.preparedClassNames(index).length==2,"all original DEX names available before converter configuration");
  var app=HostDexFiles.application(index,List.of(one,two),data,DemandDexProbe.class.getClassLoader());
  GuestNativeLoader.configure(base.resolve("native/libklepton-jvm.dylib").toString(),data.toString(),index.toString(),app);
  DynamicDex.configure(tools,Files.createDirectories(data.resolve("cache")),index,app);
  try{
   independentClassDefinition(app);independentPublication(app);check(answer(app)==42,"demand-defined feature split class");
   check(app.loadClass("fixture.Value").getClassLoader()==app,"original AOSP defining loader");
   check(app.loadClass("android.app.Activity")==android.app.Activity.class,"complete upstream framework identity");
   try(var asset=app.getResourceAsStream("asset.txt")){check(asset!=null&&asset.read()==42,"original APK resource");}
   var memory=new InMemoryDexClassLoader(ByteBuffer.wrap(Files.readAllBytes(Path.of(args[3]))),null);
   check(answer(memory)==42,"dynamic in-memory DEX uses same per-class converter");
   check(memory.loadClass("fixture.Value")!=app.loadClass("fixture.Value"),"byte reuse does not share defining class owners");
   var repeat=new InMemoryDexClassLoader(ByteBuffer.wrap(Files.readAllBytes(Path.of(args[3]))),null);check(answer(repeat)==42,"repeated dynamic module");
   check(HostDexFiles.headers(memory).equals(HostDexFiles.headers(repeat)),"same immutable module index cache");
   independentWarmBytes(index,List.of(one,two),DemandDexProbe.class.getClassLoader());writerDoesNotOwnByteCache();
   try{app.loadClass("fixture.notthere.Missing");throw new AssertionError("missing class");}catch(ClassNotFoundException expected){}
   // The component factory was indexed but never requested. Only Value's
   // bytecode may have entered the existing shared artifact cache.
   if(cold)try(var files=Files.walk(data.resolve("cache/dynamic-dex/artifacts"))){for(Path file:files.filter(p->p.getFileName().toString().equals("classes.jar")).toList())try(var zip=new ZipFile(file.toFile())){check(zip.getEntry("fixture/packagecontext/Factory.class")==null,"unused class was not translated");}}
   HostDexFiles.installed(index,List.of(one,two));
   var packageContext=new PathClassLoader(one.toString(),null);
   check(packageContext.loadClass("fixture.packagecontext.Factory").getConstructor().newInstance() instanceof android.app.AppComponentFactory,"original package context consumes demand-indexed code");
   try{packageContext.loadClass("fixture.Value");throw new AssertionError("base APK exposed a feature split class");}catch(ClassNotFoundException expected){}
   packageContext.addDexPath(two.toString());check(answer(packageContext)==42,"original split membership and addDexPath are preserved");
   check(packageContext.loadClass("fixture.Value")!=app.loadClass("fixture.Value"),"package contexts share bytes, never defining loaders");
   var children=ProcessHandle.current().children().filter(p->p.info().commandLine().orElse("").contains("DemandDexConvert")).toList();
   sharedHeaderSnapshots();awaitPersistence();if(cold)legacyContextNames(data.resolve("cache/dynamic-dex/artifacts"));
   System.out.println("activeDemandWorkers="+children.size());DynamicDex.hostShutdown();check(children.stream().noneMatch(ProcessHandle::isAlive),"converter children retire together");
   try(var files=Files.walk(data.resolve("cache/dynamic-dex"))){check(files.noneMatch(p->p.getFileName().toString().startsWith("demand-")),"converter inputs retire at shutdown");}
   check(answer(app)==42&&answer(memory)==42,"already-defined classes survive converter shutdown");
  }finally{DynamicDex.hostShutdown();HostDexFiles.clearInstalled();}
  System.out.println("PASS demand APK + dynamic DEX, upstream loaders, unused classes, warm cache and cleanup");
 }
}
