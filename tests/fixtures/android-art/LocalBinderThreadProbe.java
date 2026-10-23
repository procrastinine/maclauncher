package maclauncher.android;

import android.os.*;
import java.lang.reflect.Method;
import java.util.concurrent.ConcurrentLinkedQueue;

/** Original ART Binder/Parcel calls from native threads, without an Activity. */
public final class LocalBinderThreadProbe {
 public static final class BootImageProbe {
  private static native boolean hasBootImage();
  public static void main(String[] args)throws Exception {
   System.load("/system/lib64/boot-image-space-probe.so");
   boolean actual=hasBootImage();
   if(actual!=Boolean.parseBoolean(args[0]))throw new AssertionError("Original ART image-space owner differs from the requested mode: "+actual);
   ClassLoader loader=ClassLoader.getSystemClassLoader();
   Class.forName("android.app.Activity",false,loader).getMethod("getActionBar");
   Class.forName("android.graphics.drawable.BitmapDrawable",false,loader).getMethod("setGravity",int.class);
   Class.forName("com.android.server.am.ActivityManagerService",false,loader);
   Class.forName("maclauncher.android.Art",false,loader);
   if(!"ab".equals(new StringBuilder().append('a').append('b').toString()))throw new AssertionError("Java execution failed");
   System.out.println("PASS original framework/services/adapters boot image execution="+actual);
  }
 }
 private static native void exercise(IBinder endpoint);
 private static final String DESCRIPTOR="maclauncher.android.fixture.LocalThread";
 private static void checkProcessIdentity(){
  int pid=android.os.Process.myPid(),uid=android.os.Process.myUid();
  if(Binder.getCallingPid()!=pid||Binder.getCallingUid()!=uid||android.system.Os.getpid()!=pid)throw new AssertionError("Local Binder differs from the Android process identity");
  long token=Binder.clearCallingIdentity();
  if(Binder.getCallingPid()!=pid||Binder.getCallingUidOrThrow()!=uid)throw new AssertionError("Cleared Binder differs from the Android process identity");
  Binder.restoreCallingIdentity(token);
  if(Binder.getCallingPid()!=pid||Binder.getCallingUid()!=uid)throw new AssertionError("Restored local Binder differs from the Android process identity");
 }
 private static final ConcurrentLinkedQueue<Thread> threads=new ConcurrentLinkedQueue<>();
 private static final Binder endpoint=new Binder(){
  @Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags)throws RemoteException{
   if(code!=FIRST_CALL_TRANSACTION)return super.onTransact(code,data,reply,flags);
   checkProcessIdentity();
   data.enforceInterface(DESCRIPTOR);int value=data.readInt();data.enforceNoDataAvail();
   threads.add(Thread.currentThread());reply.writeNoException();reply.writeInt(value*2);reply.writeStrongBinder(this);return true;
  }
 };
 public static void main(String[]args)throws Exception{
  System.load("/system/lib64/libart-rpc.so");System.load("/system/lib64/libart-platform.so");
  Method initialize=Class.forName("maclauncher.android.ArtPlatform").getDeclaredMethod("initializeRpc",int.class);initialize.setAccessible(true);initialize.invoke(null,Integer.parseInt(args[0]));
  checkProcessIdentity();
  System.load("/system/lib64/local-binder-thread-probe.so");
  IInterface owner=()->endpoint;endpoint.attachInterface(owner,DESCRIPTOR);Thread caller=Thread.currentThread();
  exercise(endpoint);
  checkProcessIdentity();
  if(args.length>1){
   if(android.os.Process.myUid()!=10021||android.os.Process.myPid()<=0)throw new AssertionError("Native identity was not initialized per process");
   Class.forName("android.app.Activity",false,ClassLoader.getSystemClassLoader()).getMethod("getActionBar");
   Class.forName("android.graphics.drawable.BitmapDrawable",false,ClassLoader.getSystemClassLoader()).getMethod("setGravity",int.class);
   Class.forName("com.android.server.am.ActivityManagerService",false,ClassLoader.getSystemClassLoader());
   Class.forName("maclauncher.android.Art",false,ClassLoader.getSystemClassLoader());
   System.out.println("PASS original framework/services/adapters and per-process identity");
  }
  if(Thread.currentThread()!=caller||endpoint.queryLocalInterface(DESCRIPTOR)!=owner)throw new AssertionError("Original Java endpoint identity changed");
  if(threads.size()!=16)throw new AssertionError("Native callbacks missing: "+threads.size());
  for(Thread thread:threads)if(thread==caller||thread.isAlive())throw new AssertionError("Native callback attachment was not retired");
  System.gc();System.runFinalization();System.gc();
  System.out.println("PASS original local Binder identity, Parcel callbacks and native-thread attachment retirement");
 }
}
