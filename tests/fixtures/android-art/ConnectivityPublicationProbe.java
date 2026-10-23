package maclauncher.android;

import android.os.*;
import java.lang.reflect.*;

/** Exercise the delivered original JNI and generated AIDL endpoint. */
public final class ConnectivityPublicationProbe {
 private static Object call(String name,Class<?>[]types,Object...args)throws Exception{
  Method method=Class.forName("maclauncher.android.ArtPlatform").getDeclaredMethod(name,types);
  method.setAccessible(true);return method.invoke(null,args);
 }
 private static void publish()throws Exception{
  Object target=Class.forName("maclauncher.android.framework.HostConnectivityManager").getMethod("service").invoke(null);
  Class<?> contract=Class.forName("android.net.IConnectivityManager");
  IBinder endpoint=(IBinder)Class.forName("maclauncher.android.framework.endpoints.android.net.IConnectivityManager")
   .getConstructor(contract,PermissionEnforcer.class).newInstance(target,new PermissionEnforcer(null));
  call("service",new Class<?>[]{String.class,IBinder.class},"connectivity",endpoint);
 }
 public static void main(String[]args){
  try{
   System.load("/system/lib64/libart-rpc.so");System.load("/system/lib64/libart-platform.so");
   call("initializeRpc",new Class<?>[]{int.class},Integer.parseInt(args[1]));
   if(args[0].equals("absent")){
    try{call("connectivity",new Class<?>[0]);throw new AssertionError("Absent service returned an endpoint");}
    catch(InvocationTargetException failure){if(!(failure.getCause() instanceof java.io.IOException))throw failure;}
    System.err.println("PASS original absent connectivity result");System.exit(0);
   }
   publish();System.gc();System.runFinalization();System.gc();
   IBinder result=(IBinder)call("connectivity",new Class<?>[0]);
   if(result==null||!result.getInterfaceDescriptor().equals("android.net.IConnectivityManager"))throw new AssertionError("Publication did not survive Java GC");
   System.err.println("READY original Java connectivity publication");
   if(System.in.read()!='1')throw new AssertionError("Missing retirement request");
   System.exit(0);
  }catch(Throwable failure){failure.printStackTrace(System.err);System.exit(1);}
 }
}
