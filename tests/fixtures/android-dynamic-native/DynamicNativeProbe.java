import java.net.*;
import java.nio.file.*;
import java.lang.reflect.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import maclauncher.android.bridge.GuestNativeLoader;
public final class DynamicNativeProbe {
 private static native void install(String runtime);
 private static native int calls();
 private static final class Module extends URLClassLoader{
  volatile CountDownLatch entryRequested;
  Module(Path jar,ClassLoader parent)throws Exception{super(new URL[]{jar.toUri().toURL()},parent);}
  protected Class<?> loadClass(String name,boolean resolve)throws ClassNotFoundException{
   CountDownLatch requested=entryRequested;
   if(requested!=null&&Thread.currentThread().getName().equals("native-owner")&&name.equals("java.lang.Object"))requested.countDown();
   return super.loadClass(name,resolve);
  }
  protected Class<?> findClass(String name)throws ClassNotFoundException{Class<?> type=super.findClass(name);GuestNativeLoader.classDefined(type);return type;}
 }
 private static void concurrentOwner(Module loader,Class<?> guest)throws Exception{
  CountDownLatch held=new CountDownLatch(1),entryRequested=new CountDownLatch(1);loader.entryRequested=entryRequested;
  AtomicReference<Throwable> failure=new AtomicReference<>();
  Method owner=GuestNativeLoader.class.getDeclaredMethod("owner",Class.class);owner.setAccessible(true);
  Thread defining=new Thread(()->{try{synchronized(loader){held.countDown();if(!entryRequested.await(3,TimeUnit.SECONDS))throw new AssertionError("owner did not begin");GuestNativeLoader.classDefined(guest);}}catch(Throwable error){failure.compareAndSet(null,error);}},"guest-definition");
  Thread loading=new Thread(()->{try{if(!held.await(3,TimeUnit.SECONDS))throw new AssertionError("guest loader not held");Object actual=owner.invoke(null,guest);entryRequested.countDown();Method entry=actual.getClass().getDeclaredMethod("entry");entry.setAccessible(true);entry.invoke(actual);}catch(Throwable error){failure.compareAndSet(null,error);}},"native-owner");
  defining.setDaemon(true);loading.setDaemon(true);defining.start();loading.start();defining.join(4000);loading.join(4000);
  if(defining.isAlive()||loading.isAlive())throw new AssertionError("native owner publication deadlocked guest class definition");
  if(failure.get()!=null)throw new AssertionError("native owner publication",failure.get());loader.entryRequested=null;
 }
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]),binding=Path.of(args[1]),helper=Path.of(args[2]),root=Path.of(args[3]),app=Path.of(args[4]),module=Path.of(args[5]);
  System.load(binding.toString());System.load(helper.toString());install(runtime.toString());
  maclauncher.android.fixture.RuntimeFixture.initialize(runtime.getParent().getParent().toString(),root.getParent().resolve("data").toString());
  try(URLClassLoader application=new URLClassLoader(new URL[]{app.toUri().toURL()},DynamicNativeProbe.class.getClassLoader());Module first=new Module(module,application);Module second=new Module(module,application)){
   GuestNativeLoader.configure(runtime.toString(),root.toString(),app.toString(),application);
   Class<?> guest=first.loadClass("owned.dynamic.NativeChild");concurrentOwner(first,guest);guest.getMethod("load").invoke(null);guest.getMethod("preparedRuntimeLoad").invoke(null);guest.getMethod("runtimeLoad").invoke(null);
   if((int)guest.getMethod("value").invoke(null)!=73||calls()!=1)throw new AssertionError("image reuse and JNI_OnLoad count");
   try{second.loadClass("owned.dynamic.NativeChild").getMethod("load").invoke(null);throw new AssertionError("borrowed JNI owner accepted");}catch(InvocationTargetException expected){if(!(expected.getCause() instanceof UnsatisfiedLinkError)||!expected.getCause().getMessage().contains("another class loader"))throw expected;}
   if((int)guest.getMethod("value").invoke(null)!=73||calls()!=1)throw new AssertionError("foreign owner changed image");
  }
  System.out.println("PASS actual dynamic JNI owner, concurrent owner publication, worker class definition, late binding and image reuse");
 }
}
