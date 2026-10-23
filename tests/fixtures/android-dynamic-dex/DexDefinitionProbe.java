import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.lang.reflect.InvocationTargetException;
import java.util.jar.JarFile;
import maclauncher.android.framework.*;

/** Repeated ART requests share the JVM loader's existing class identity. */
public final class DexDefinitionProbe {
 private static native void install(Class<?> owner);
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]),jar=Path.of(args[1]),data=Files.createDirectories(Path.of(args[2]));
  HostFilesystem.configure(runtime,data,data,data,"owned.dex.identity");
  System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(runtime.resolve("native/libnativebinding.dylib").toString());
  JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
  if(args.length>3){System.load(args[3]);install(HostDexFiles.class);}
  var loader=HostDexFiles.application(jar,List.of(),data,DexDefinitionProbe.class.getClassLoader());
  Class<?> first=loader.loadClass("fixture.Value");
  check(loader.loadClass("fixture/Value")==first,"slash-form JNI request reused existing definition");
  var other=HostDexFiles.application(jar,List.of(),data,DexDefinitionProbe.class.getClassLoader());
  try(var workers=Executors.newFixedThreadPool(4)){
   var start=new CountDownLatch(1);var results=new ArrayList<Future<Class<?>>>();
   for(int i=0;i<12;i++){String name=i%2==0?"fixture.Value":"fixture/Value";results.add(workers.submit(()->{start.await();return other.loadClass(name);}));}
   start.countDown();Class<?> concurrent=results.getFirst().get(5,TimeUnit.SECONDS);
   for(var result:results)check(result.get(5,TimeUnit.SECONDS)==concurrent,"concurrent first definition owner");
  }
  check(other.loadClass("fixture.Value")!=first,"independent loaders retain distinct identity");
  check(first.getClassLoader()==loader&&(int)first.getMethod("answer").invoke(null)==7,"actual original class executes");
  var define=HostDexFiles.class.getDeclaredMethod("defineBytecode",String.class,ClassLoader.class,byte[].class);define.setAccessible(true);
  byte[] bytes;try(var archive=new JarFile(jar.toFile());var input=archive.getInputStream(archive.getJarEntry("fixture/Value.class"))){bytes=input.readAllBytes();}
  ClassLoader retryOwner=new ClassLoader(DexDefinitionProbe.class.getClassLoader()){};
  try{define.invoke(null,"fixture.Value",retryOwner,new byte[]{0,1,2,3});throw new AssertionError("invalid class bytes accepted");}
  catch(InvocationTargetException expected){check(expected.getCause() instanceof ClassFormatError,"original JVM definition failure retained");}
  Class<?> retried;
  try(var worker=Executors.newSingleThreadExecutor()){
   retried=(Class<?>)worker.submit(()->define.invoke(null,"fixture.Value",retryOwner,bytes)).get(5,TimeUnit.SECONDS);
  }
  check(retried.getClassLoader()==retryOwner&&(int)retried.getMethod("answer").invoke(null)==7,"first dotted definition after failure and lock retirement");
  check(define.invoke(null,"fixture/Value",retryOwner,bytes)==retried,"direct DEX definition reuses successful retry");
  System.out.println("PASS original DEX loader repeated, slash-form and concurrent class identity");
 }
}
