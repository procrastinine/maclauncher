package maclauncher.android;

import android.app.IApplicationThread;
import android.content.*;
import android.content.pm.ActivityInfo;
import android.os.*;
import java.lang.reflect.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import maclauncher.android.bridge.LocalBroadcasts;
import maclauncher.android.framework.*;

/** Actual shared remote-broadcast routing over the selected VM's original core. */
public final class ArtBroadcastRoutingProbe {
 public static void main(String[] args)throws Exception {run();System.exit(0);}
 private static void run()throws Exception {
  CountDownLatch entered=new CountDownLatch(2),release=new CountDownLatch(1);
  AtomicReference<Throwable> failure=new AtomicReference<>();Thread caller=Thread.currentThread();
  HostRemoteServices.resolver((HostProcessServices.Key key,String request)->{
   try{
    if(Thread.currentThread()==caller||!Thread.currentThread().isDaemon())throw new AssertionError("Broadcast routing must use its daemon owner");
    entered.countDown();if(!release.await(5,TimeUnit.SECONDS))throw new AssertionError("Concurrent remote routes did not start");
   }catch(Throwable error){failure.compareAndSet(null,error);}
   finally{HostRemoteServices.unavailable(key,request);}
  });
  Class<?> target=Class.forName("maclauncher.android.bridge.LocalBroadcasts$Target");
  Constructor<?> constructor=target.getDeclaredConstructor(IApplicationThread.class,IIntentReceiver.class,ActivityInfo.class,boolean.class);constructor.setAccessible(true);
  Method deliver=LocalBroadcasts.class.getDeclaredMethod("deliver",target,Intent.class,String.class,int.class,String.class,Bundle.class,boolean.class,boolean.class,int.class,String.class,int.class);deliver.setAccessible(true);
  Field field=LocalBroadcasts.class.getDeclaredField("routing");field.setAccessible(true);ExecutorService routing=null;
  try{
   for(int i=0;i<2;i++){ActivityInfo info=new ActivityInfo();info.packageName="fixture.receiver"+i;info.name="Receiver";info.processName=info.packageName;
    deliver.invoke(null,constructor.newInstance(null,null,info,true),new Intent("fixture.BROADCAST"),null,0,null,null,false,false,0,"fixture.sender",10001);}
   routing=(ExecutorService)field.get(null);
   if(!entered.await(5,TimeUnit.SECONDS))throw new AssertionError("Both original broadcast routes must progress concurrently");
  }finally{release.countDown();System.err.println("Broadcast fixture: retire routing");LocalBroadcasts.shutdown();System.err.println("Broadcast fixture: routing shutdown requested");}
  if(routing==null||!routing.awaitTermination(5,TimeUnit.SECONDS))throw new AssertionError("Broadcast routing did not retire");
  System.err.println("Broadcast fixture: routing terminated");HostRemoteServices.shutdown();System.err.println("Broadcast fixture: process directory retired");if(failure.get()!=null)throw new AssertionError("Original remote route failed",failure.get());
  System.err.println("PASS shared original-core broadcast routing: concurrent daemon delivery and owned retirement");
 }
}
