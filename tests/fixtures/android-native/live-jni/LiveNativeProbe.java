import java.net.*;
import java.nio.file.*;
import maclauncher.android.bridge.GuestNativeLoader;
public final class LiveNativeProbe {
 private static native void install(String core,String binding);
 private static native void prepareEntry(Class<?> entry);
 private static native void unregister(Class<?> target);
 private static native void registerPartial(Class<?> target);
 private static native void clearManual(Class<?> target);
 private static native void registerDisposable(Class<?> target);
 private static native void exposeLifetime();
 private static final class Owner extends URLClassLoader {
  Owner(Path jar)throws Exception{super(new URL[]{jar.toUri().toURL()},LiveNativeProbe.class.getClassLoader());}
  protected Class<?> findClass(String name)throws ClassNotFoundException{Class<?> type=super.findClass(name);GuestNativeLoader.classDefined(type);return type;}
 }
 private static int call(Class<?> type,String name)throws Exception{return (int)type.getMethod(name).invoke(null);}
 private static java.lang.ref.WeakReference<?>[] disposable(ClassLoader parent)throws Exception{
  byte[] bytes;try(var input=parent.getResourceAsStream("owned/live/Disposable.class")){if(input==null)throw new AssertionError("Disposable fixture is missing");bytes=input.readAllBytes();}
  class DisposableLoader extends ClassLoader {
   DisposableLoader(){super(parent);}
   Class<?> define(){return defineClass("owned.live.Disposable",bytes,0,bytes.length);}
  }
  var loader=new DisposableLoader();Class<?> type=loader.define();registerDisposable(type);
  return new java.lang.ref.WeakReference<?>[]{new java.lang.ref.WeakReference<>(type),new java.lang.ref.WeakReference<>(loader)};
 }
 private static void registrationLifetime(Owner owner,Class<?> type)throws Exception{
  Class<?> parent=type.getSuperclass();var bean=java.lang.management.ManagementFactory.getClassLoadingMXBean();long unloaded=bean.getUnloadedClassCount();
  var weak=disposable(owner);if(call(parent,"lifetime")!=95)throw new AssertionError("inherited explicit registration did not bind original parent");
  long deadline=System.nanoTime()+5_000_000_000L;
  while((weak[0].get()!=null||weak[1].get()!=null||bean.getUnloadedClassCount()<=unloaded)&&System.nanoTime()<deadline){System.gc();Thread.sleep(20);}
  if(weak[0].get()!=null||weak[1].get()!=null||bean.getUnloadedClassCount()<=unloaded)throw new AssertionError("Disposable class/loader did not unload");
  // The wrapper separately requires this exact class's VM ClassUnload log.
  if(call(parent,"lifetime")!=95)throw new AssertionError("subclass unload changed the VM's parent binding");
  exposeLifetime();type.getMethod("load").invoke(null);
  if(call(parent,"lifetime")!=95)throw new AssertionError("subclass unload lost explicit parent registration precedence");
  System.out.println("PASS verified Disposable class unload preserves inherited explicit registration against live export");
 }
 public static void main(String[] args)throws Exception {
  Path runtime=Path.of(args[0]);System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(args[1]);System.load(args[2]);install(runtime.resolve("native/libklepton-jvm.dylib").toString(),args[1]);
  maclauncher.android.fixture.RuntimeFixture.initialize(runtime.toString(),args[5]);
  try(Owner owner=new Owner(Path.of(args[4]))){
   Class<?> type=owner.loadClass("owned.live.Probe");
   GuestNativeLoader.configure(runtime.resolve("native/libklepton-jvm.dylib").toString(),args[3],args[4],owner);
   Class<?> delayed=owner.loadClass("owned.live.Delayed");
   boolean baseline=args.length>6&&args[6].equals("baseline");
   var prepared=baseline?null:Class.forName("maclauncher.android.bridge.NativeBinding").getDeclaredMethod("isPrepared",Class.class);if(prepared!=null)prepared.setAccessible(true);
   if(prepared!=null&&(boolean)prepared.invoke(null,delayed))throw new AssertionError("fixture class was already prepared");
   if(args.length>6&&args[6].equals("prepared")){
    var find=GuestNativeLoader.class.getDeclaredMethod("owner",Class.class);find.setAccessible(true);Object actual=find.invoke(null,type);
    var entry=actual.getClass().getDeclaredMethod("entry");entry.setAccessible(true);var method=(java.lang.reflect.Method)entry.invoke(actual);
    if(method.getDeclaringClass().getDeclaredMethod("loadPrepared",String.class,String.class,String.class,java.util.function.LongConsumer.class)==null)throw new AssertionError("prepared Entry contract absent");
    prepareEntry(method.getDeclaringClass());
   }
   type.getMethod("load").invoke(null);
   if(call(type,"value")!=73)throw new AssertionError("constructor live export not bound");
   if((boolean)prepared.invoke(null,delayed))throw new AssertionError("native load forced unrelated class preparation");
   if(call(delayed,"value")!=76)throw new AssertionError("incremental class preparation did not bind live export");
   if((int)type.getMethod("overloaded",int.class).invoke(null,3)!=74)throw new AssertionError("long JNI export not bound");
   if(call(type,"late")!=75)throw new AssertionError("JNI_OnLoad live export not bound");
   if(call(type,"manual")!=91)throw new AssertionError("explicit registration was replaced");
   if(call(type,"inherited")!=95)throw new AssertionError("inherited explicit registration was replaced");
   try{call(type,"absent");throw new AssertionError("missing JNI export fabricated");}catch(java.lang.reflect.InvocationTargetException expected){if(!(expected.getCause() instanceof UnsatisfiedLinkError))throw expected;}
   type.getMethod("load").invoke(null);if(call(type,"manual")!=91)throw new AssertionError("repeat load replaced explicit registration");
   unregister(type);type.getMethod("load").invoke(null);
   if(call(type,"value")!=73||call(type,"manual")!=82||call(type,"late")!=75)throw new AssertionError("unregistered methods did not rebind from live image");
   if(call(type,"inherited")!=95)throw new AssertionError("subclass unregister cleared parent registration");
   unregister(type.getSuperclass());type.getMethod("load").invoke(null);if(call(type,"inherited")!=81)throw new AssertionError("parent unregister did not permit rebinding");
   boolean lifetimeOnly=java.util.Arrays.asList(args).contains("regression=lifetime");
   boolean prefixOnly=java.util.Arrays.asList(args).contains("regression=prefix");
   if(!lifetimeOnly){
    unregister(type);
    try{registerPartial(type);throw new AssertionError("invalid second registration was accepted");}catch(NoSuchMethodError expected){if(!expected.getMessage().contains("missingAfterPrefix"))throw expected;}
    if(call(type,"manual")!=92)throw new AssertionError("original VM discarded the successfully registered prefix");
    type.getMethod("load").invoke(null);if(call(type,"manual")!=92)throw new AssertionError("automatic lookup replaced a successful explicit prefix after later failure");
    System.out.println("PASS partial RegisterNatives preserves original NoSuchMethodError and committed prefix across reload");
    clearManual(type);
    try{call(type,"manual");throw new AssertionError("NULL function registration did not clear the method");}catch(java.lang.reflect.InvocationTargetException expected){if(!(expected.getCause() instanceof UnsatisfiedLinkError))throw expected;}
    type.getMethod("load").invoke(null);if(call(type,"manual")!=82)throw new AssertionError("NULL function registration prevented live export rebinding");
    System.out.println("PASS NULL native function clears only its original method and permits live export rebinding");
   }
   if(!prefixOnly)registrationLifetime(owner,type);
   try(Owner foreign=new Owner(Path.of(args[4]))){Class<?> other=foreign.loadClass("owned.live.Delayed");try{call(other,"value");throw new AssertionError("foreign loader borrowed JNI export");}catch(java.lang.reflect.InvocationTargetException expected){if(!(expected.getCause() instanceof UnsatisfiedLinkError))throw expected;}}
  }
  System.out.println("PASS real ELF mutable JNI names, short/long live lookup, post-onload retry, explicit registration precedence, missing export, unregister/reload");
 }
}
