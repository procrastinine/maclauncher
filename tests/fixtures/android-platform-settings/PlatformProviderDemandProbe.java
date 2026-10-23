package maclauncher.android.framework;

import android.app.ActivityThread;
import android.content.Context;
import android.content.IContentProvider;
import android.content.pm.ProviderInfo;
import android.os.*;
import java.util.*;
import java.util.concurrent.*;

/** Concurrent local acquisition shares the original main-thread attachment. */
public final class PlatformProviderDemandProbe {
 private PlatformProviderDemandProbe(){}
 public static void prepare(Context context,ProviderInfo info)throws Exception {
  var thread=ActivityThread.currentActivityThread();
  if(thread.acquireExistingProvider(context,"settings",context.getUserId(),true)!=null)
   throw new AssertionError("Provider was attached before the first demand");
  var workers=Executors.newFixedThreadPool(9);
  try{
   // Remote references request publication asynchronously. The main owner is
   // deliberately not pumping yet, so this request must return immediately.
   workers.submit(()->HostPlatformPackages.request(context,info)).get(2,TimeUnit.SECONDS);
   CountDownLatch arrived=new CountDownLatch(9);
   Future<IBinder> sensor=workers.submit(()->{
    arrived.countDown();
    return HostServices.manager().checkService(Context.SENSOR_PRIVACY_SERVICE);
   });
   var acquisitions=new ArrayList<Future<IContentProvider>>();
   for(int i=0;i<8;i++)acquisitions.add(workers.submit(()->{
    arrived.countDown();HostPlatformPackages.demand(context,info);
    var provider=thread.acquireExistingProvider(context,"settings",context.getUserId(),true);
    if(provider==null)throw new AssertionError("Synchronous acquisition returned before original provider attachment");
    return provider;
   }));
   if(!arrived.await(2,TimeUnit.SECONDS))throw new AssertionError("Concurrent acquisitions did not start");
   Thread.sleep(50);
   for(var acquisition:acquisitions)if(acquisition.isDone())throw new AssertionError("Off-main demand returned before the main owner ran");
   if(sensor.isDone())throw new AssertionError("Original sensor privacy construction did not await its Settings provider");
   // Main-thread adoption of the already queued task must progress without
   // self-waiting. SettingsProvider's own startup also performs Settings reads.
   HostPlatformPackages.demand(context,info);
   IContentProvider original=thread.acquireExistingProvider(context,"settings",context.getUserId(),true);
   if(original==null)throw new AssertionError("Original attachment is unavailable");
   for(var acquisition:acquisitions)if(acquisition.get(5,TimeUnit.SECONDS).asBinder()!=original.asBinder())
    throw new AssertionError("Concurrent demand attached a second provider");
   long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
   while(!sensor.isDone()&&System.nanoTime()<deadline){HostLooper.drain(Looper.getMainLooper());Thread.sleep(1);}
   IBinder sensorEndpoint=sensor.get(1,TimeUnit.SECONDS);
   if(sensorEndpoint==null||!android.hardware.ISensorPrivacyManager.DESCRIPTOR.equals(sensorEndpoint.getInterfaceDescriptor()))
    throw new AssertionError("Original sensor privacy construction failed after provider attachment");
   android.hardware.ISensorPrivacyManager.Stub.asInterface(sensorEndpoint).isSensorPrivacyEnabled();
   HostLooper.drain(Looper.getMainLooper());
   HostPlatformPackages.demand(context,info);
   if(thread.acquireExistingProvider(context,"settings",context.getUserId(),true).asBinder()!=original.asBinder())
    throw new AssertionError("Queued task replaced the original provider");
   if(!"com.android.providers.settings.SettingsProvider".equals(android.content.ContentProvider.coerceToLocalContentProvider(original).getClass().getName()))
    throw new AssertionError("Provider is not the original supplied implementation");
   System.out.println("PASS concurrent platform provider demand: asynchronous request, eight blocked callers, original sensor privacy construction, main adoption and one original attachment");
  }finally{workers.shutdownNow();if(!workers.awaitTermination(2,TimeUnit.SECONDS))throw new AssertionError("Provider acquisition workers did not stop");}
 }
}
