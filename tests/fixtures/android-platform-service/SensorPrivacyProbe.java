package maclauncher.android;

import android.content.Context;
import android.hardware.*;
import android.os.*;
import java.nio.file.*;
import maclauncher.android.framework.*;

/** Original profile system boot and sensor privacy state/listener ownership. */
public final class SensorPrivacyProbe {
 static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
 static void drainUntil(Looper loop,java.util.function.BooleanSupplier complete)throws Exception{
  long end=System.nanoTime()+5_000_000_000L;
  while(!complete.getAsBoolean()&&System.nanoTime()<end){HostLooper.drain(loop);Thread.sleep(2);}
  check(complete.getAsBoolean(),"original sensor privacy listener delivery");
 }
 public static void main(String[] args){try{run(args);System.exit(0);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
 static void run(String[] args)throws Exception{
  Path runtime=Path.of(args[0]),data=Path.of(args[1]),files=Files.createDirectories(data.resolve("files")),cache=Files.createDirectories(data.resolve("cache"));
  RuntimeBootstrap.initialize(runtime,data,files,cache,"android.system",false,false,false);
  HostProcessIdentity.configure(android.os.Process.SYSTEM_UID,android.system.Os.getuid());Looper loop=HostLooper.main();
  try(var owner=HostSystemServices.start(runtime,data,"android.system")){
   ISensorPrivacyManager service=ISensorPrivacyManager.Stub.asInterface(ServiceManager.getService(Context.SENSOR_PRIVACY_SERVICE));
   var local=HostServices.manager().checkService(Context.SENSOR_PRIVACY_SERVICE).queryLocalInterface(ISensorPrivacyManager.DESCRIPTOR);
   check(local!=null&&local.getClass().getName().startsWith("com.android.server.sensorprivacy.SensorPrivacyService$"),"original sensor privacy service is the Binder owner: "+(local==null?"no local endpoint":local.getClass().getName()));
   check(service!=null,"original Binder client reaches sensor privacy");
   SensorPrivacyManager manager=HostApplication.applicationContext().getSystemService(SensorPrivacyManager.class);
   check(manager!=null,"original sensor privacy client is available");
   service.requiresAuthentication();manager.isSensorPrivacyEnabled(SensorPrivacyManager.TOGGLE_TYPE_SOFTWARE,SensorPrivacyManager.Sensors.CAMERA);
   var changed=new java.util.concurrent.atomic.AtomicInteger();var latest=new java.util.concurrent.atomic.AtomicBoolean();ISensorPrivacyListener listener=new ISensorPrivacyListener.Stub(){
    public void onSensorPrivacyChanged(int toggle,int sensor,boolean enabled){changed.incrementAndGet();latest.set(enabled);}
    public void onSensorPrivacyStateChanged(int toggle,int sensor,int state){changed.incrementAndGet();}
   };
   service.addSensorPrivacyListener(listener);
   try{
    if(args[2].equals("read"))check(service.isSensorPrivacyEnabled(),"original persisted privacy state survived system-owner restart");
    service.setSensorPrivacy(false);check(!service.isSensorPrivacyEnabled(),"privacy state can be cleared");
    service.setSensorPrivacy(true);check(service.isSensorPrivacyEnabled()&&manager.isAllSensorPrivacyEnabled(),"original service and client share privacy state");
    drainUntil(loop,latest::get);
    service.removeSensorPrivacyListener(listener);int before=changed.get();service.setSensorPrivacy(false);
    for(int i=0;i<30;i++){HostLooper.drain(loop);Thread.sleep(2);}
    check(changed.get()==before,"privacy listener removal retires callbacks");
    service.setSensorPrivacy(args[2].equals("write"));
    // The original public global kill switch does not schedule persistence
    // after every call. Exercise the controller's explicit checkpoint directly;
    // private reflection remains only in this test, not the runtime adapter.
    var stateField=local.getClass().getDeclaredField("mSensorPrivacyStateController");stateField.setAccessible(true);Object state=stateField.get(local);
    var persist=Class.forName("com.android.server.sensorprivacy.SensorPrivacyStateController").getDeclaredMethod("persistAll");persist.setAccessible(true);persist.invoke(state);
    var saved=new java.util.concurrent.CountDownLatch(1);com.android.server.IoThread.getHandler().post(saved::countDown);
    check(saved.await(5,java.util.concurrent.TimeUnit.SECONDS),"original asynchronous privacy persistence completed");HostLooper.drain(loop);
   }finally{service.removeSensorPrivacyListener(listener);}
  }finally{HostApplication.shutdown();HostLooper.close(loop);FrameworkResources.shutdown();}
  System.out.println("PASS original sensor privacy system boot, client, state, listeners and persistence");
 }
}
