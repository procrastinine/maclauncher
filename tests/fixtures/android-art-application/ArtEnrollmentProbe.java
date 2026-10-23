package maclauncher.android;
import android.os.*;
import java.io.*;
import java.util.Arrays;
/** Executes the normal authority reader and original guest Binder RPC. */
public final class ArtEnrollmentProbe {
 private static native long connect(String socket,int pid,int uid,String context,String packageName,String processName)throws IOException;
 private static native IBinder root(long session);
 private static native void close(long session);
 public static void main(String[] args){try{run(args);System.exit(0);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
 private static void run(String[] args)throws Exception{
  System.load(args[0]);System.load(args[1]);System.out.println("Original Binder JNI libraries loaded");

  org.json.JSONObject launch=args.length>6?new org.json.JSONObject(args[6]):new org.json.JSONObject("{\"packageName\":\"com.maclauncher.artprobe\",\"processName\":\"com.maclauncher.artprobe\"}");
  try(ProcessAuthority authority=ProcessAuthority.read(5,launch.getString("packageName"),launch.getString("processName"))){
   if(authority.self.uid()!=android.os.Process.myUid()||authority.self.pid()!=android.os.Process.myPid())throw new AssertionError("Original ART identity differs from enrollment");
   if(authority.self.uid()<10000)throw new AssertionError("Application must not run as root");
   System.out.println("Enrolled ART pid="+authority.self.pid()+" Android uid="+authority.self.uid());
   var systemField=ProcessAuthority.class.getDeclaredField("system");systemField.setAccessible(true);
   var peer=((org.json.JSONObject)systemField.get(authority)).getJSONObject("identity");
   long session=connect(args[2],peer.getInt("pid"),peer.getInt("uid"),peer.getString("securityContext"),peer.getString("packageName"),peer.getString("processName"));try{
    IBinder root=root(session);
    if(!IServiceManager.DESCRIPTOR.equals(root.getInterfaceDescriptor()))throw new AssertionError("Original service directory descriptor");
    IServiceManager services=IServiceManager.Stub.asInterface(root);
    System.out.println("Original guest Binder service directory "+Arrays.toString(services.listServices(IServiceManager.DUMP_FLAG_PRIORITY_ALL)));
    java.util.concurrent.CountDownLatch received=new java.util.concurrent.CountDownLatch(1);
    java.util.concurrent.atomic.AtomicReference<Throwable> callbackFailure=new java.util.concurrent.atomic.AtomicReference<>();
    IServiceCallback callback=new IServiceCallback.Stub(){@Override public boolean onTransact(int code,Parcel data,Parcel reply,int flags)throws RemoteException{System.out.println("Callback dispatch code="+code+" flags="+Integer.toHexString(flags)+" bytes="+data.dataSize());try{return super.onTransact(code,data,reply,flags);}catch(Throwable failure){failure.printStackTrace();throw failure;}}public void onRegistration(String name,IBinder service){try{if(!"window".equals(name)||service==null)throw new AssertionError("Original callback payload");if(Binder.getCallingUid()!=peer.getInt("uid")||Binder.getCallingPid()!=peer.getInt("pid"))throw new AssertionError("Callback caller differs from authenticated profile owner");System.out.println("Original Binder callback uid="+Binder.getCallingUid()+" pid="+Binder.getCallingPid()+" service="+service.getInterfaceDescriptor());}catch(Throwable failure){callbackFailure.set(failure);}finally{received.countDown();}}};
    services.registerForNotifications("window",callback);
    try{if(!received.await(3,java.util.concurrent.TimeUnit.SECONDS))throw new AssertionError("Original Binder callback not delivered");if(callbackFailure.get()!=null)throw new AssertionError("Callback",callbackFailure.get());}
    finally{services.unregisterForNotifications("window",callback);}
    if(args.length>3)ArtGraphicsProbe.run(args,services);
    try{services.tryUnregisterService("maclauncher.art.unauthorized",null);throw new AssertionError("App acquired system service registration");}
    catch(SecurityException expected){System.out.println("Original service owner rejected app UID registration");}
   }catch(Throwable failure){failure.printStackTrace();throw failure;}finally{close(session);}
   System.out.println("ART authenticated profile enrollment + original guest Binder passed");
  }
 }
}
