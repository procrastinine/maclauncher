package maclauncher.android.fixture;
import android.app.*;import android.app.job.*;import android.content.*;import android.content.pm.*;import android.os.*;
import maclauncher.android.framework.*;import java.nio.file.*;import java.util.*;import java.util.zip.*;

/** Full framework jobs and token APIs, with the local platform service below them. */
public final class JobSchedulerProbe {
 static Application application;static Thread owner;static JobParameters active;static Owned service;static boolean asynchronous;
 static final List<String> events=new ArrayList<>();
 static final List<String> localEvents=new ArrayList<>();static Plain local;
 public static final class Plain extends android.app.Service {
  final IBinder binder=new Binder();int start;
  public void onCreate(){check(Thread.currentThread()==owner&&getApplication()==application,"local service process ownership");local=this;localEvents.add("create");}
  public int onStartCommand(Intent intent,int flags,int id){start=id;localEvents.add("start");return START_NOT_STICKY;}
  public IBinder onBind(Intent intent){localEvents.add("bind");return binder;}
  public boolean onUnbind(Intent intent){localEvents.add("unbind");return true;}
  public void onRebind(Intent intent){localEvents.add("rebind");}
  public void onDestroy(){localEvents.add("destroy");}
 }
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static final class Owned extends JobService {
  public void onCreate(){check(Thread.currentThread()==owner&&getApplication()==application,"service process attachment");events.add("create");service=this;}
  public boolean onStartJob(JobParameters parameters){check(Thread.currentThread()==owner,"original JobServiceEngine owner");active=parameters;events.add("start");return asynchronous;}
  public boolean onStopJob(JobParameters parameters){check(parameters.getStopReason()==JobParameters.STOP_REASON_CANCELLED_BY_APP,"original stop reason");events.add("stop");return false;}
  public void onDestroy(){events.add("destroy");}
 }
 static JobInfo job(int id){return new JobInfo.Builder(id,new ComponentName(application,Owned.class)).setMinimumLatency(0).build();}
 public static void main(String[] args)throws Exception {
  owner=Thread.currentThread();Path runtime=Path.of(args[0]).toRealPath(),data=Path.of(args[1]).toRealPath(),apk=data.resolve("jobs.apk");
  try(var zip=new ZipOutputStream(Files.newOutputStream(apk))){zip.putNextEntry(new ZipEntry("assets/owned"));zip.write(1);zip.closeEntry();}
  PackageManifest.add(apk,"jobs");
  String pkg="owned.jobs";HostFilesystem.configure(runtime,data,data,data,pkg);
  System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());System.setProperty("klepton.bridge",runtime.resolve("native/libklepton-jvm.dylib").toString());System.setProperty("klepton.audio",runtime.resolve("native/libklepton-audio.dylib").toString());
  System.load(System.getProperty("klepton.bridge"));System.load(runtime.resolve("native/libnativebinding.dylib").toString());JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
  maclauncher.android.bridge.Bridge.configure(data.toString(),data.toString());FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));HostContext.hostPackage(pkg,"1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostContext.hostClassLoader(JobSchedulerProbe.class.getClassLoader());
  HostPackages.inspectSources(List.of(apk));
  Looper loop=HostLooper.main();HostApplication.prepare(JobSchedulerProbe.class.getClassLoader());Context context=HostApplication.applicationContext();application=new Application();HostApplication.attach(application,context);HostJobScheduler.hostConfigure(application,loop);
  try{
   JobScheduler root=application.getSystemService(JobScheduler.class),jobs=root.forNamespace("owned");check(root.getClass()==JobSchedulerImpl.class,"original complete JobSchedulerImpl");check(jobs.schedule(job(1))==1,"accepted local job");HostLooper.drain(loop);check(events.equals(List.of("create","start","destroy")),"real service lifecycle and completion");check(jobs.getPendingJob(1)==null,"completed job retired");events.clear();
   asynchronous=true;check(jobs.schedule(job(2))==1,"accepted asynchronous job");HostLooper.drain(loop);check(events.equals(List.of("create","start")),"original engine keeps running job");Thread worker=new Thread(()->service.jobFinished(active,false));worker.start();worker.join();HostLooper.drain(loop);check(events.equals(List.of("create","start","destroy")),"worker completion through original callback");events.clear();
   jobs.schedule(job(3));HostLooper.drain(loop);jobs.cancel(3);HostLooper.drain(loop);check(events.equals(List.of("create","start","stop","destroy")),"cancellation through original engine");events.clear();
   JobInfo delayed=new JobInfo.Builder(4,new ComponentName(application,Owned.class)).setMinimumLatency(60000).build();for(int i=0;i<2000;i++)jobs.schedule(delayed);check(jobs.getAllPendingJobs().size()==1,"replacement is bounded");jobs.cancelAll();HostLooper.drain(loop);check(events.isEmpty(),"unstarted work has no callbacks");
   Intent localIntent=new Intent().setComponent(new ComponentName(application,Plain.class));check(application.startService(localIntent).equals(localIntent.getComponent())&&localEvents.isEmpty(),"service start schedules owner work");HostLooper.drain(loop);check(localEvents.equals(List.of("create","start")),"original Service start lifecycle");
   int[] connected={0};ServiceConnection connection=new ServiceConnection(){public void onServiceConnected(ComponentName name,IBinder binder){check(Thread.currentThread()==owner&&binder==local.binder,"original LoadedApk service callback");connected[0]++;}public void onServiceDisconnected(ComponentName name){throw new AssertionError("local service disconnected unexpectedly");}};
   check(application.bindService(localIntent,connection,Context.BIND_AUTO_CREATE),"local bind accepted");HostLooper.drain(loop);check(connected[0]==1&&localEvents.getLast().equals("bind"),"original dispatcher connected");application.unbindService(connection);HostLooper.drain(loop);check(localEvents.getLast().equals("unbind"),"started service remains after unbind");
   application.bindService(localIntent,connection,Context.BIND_AUTO_CREATE);HostLooper.drain(loop);check(connected[0]==2&&localEvents.getLast().equals("rebind"),"rebind retains original service binder");check(!local.stopSelfResult(local.start-1)&&local.stopSelfResult(local.start),"original stopSelfResult token and start ID");HostLooper.drain(loop);check(!localEvents.contains("destroy"),"binding retains stopped service");application.unbindService(connection);HostLooper.drain(loop);check(localEvents.equals(List.of("create","start","bind","unbind","rebind","unbind","destroy")),"complete local service lifetime");
   Intent message=new Intent("owned.jobs.PING").setPackage(pkg);int[] received={0};BroadcastReceiver receiver=new BroadcastReceiver(){public void onReceive(Context c,Intent i){check(!isOrderedBroadcast(),"original pending broadcast result");received[0]++;}};application.registerReceiver(receiver,new IntentFilter(message.getAction()),Context.RECEIVER_NOT_EXPORTED);
   PendingIntent pending=PendingIntent.getBroadcast(application,7,message,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_ONE_SHOT);check(pending.isImmutable()&&pending.getCreatorUid()==android.os.Process.myUid(),"raw token metadata");Parcel parcel=Parcel.obtain();pending.writeToParcel(parcel,0);parcel.setDataPosition(0);PendingIntent copy=PendingIntent.CREATOR.createFromParcel(parcel);parcel.recycle();copy.send();HostLooper.drain(loop);check(received[0]==1,"raw parcel token dispatch and original ReceiverDispatcher");try{pending.send();throw new AssertionError("one shot token still active");}catch(PendingIntent.CanceledException expected){}application.unregisterReceiver(receiver);
   try(var workers=java.util.concurrent.Executors.newFixedThreadPool(4)){
    var tokens=new ArrayList<java.util.concurrent.Future<PendingIntent>>();for(int i=0;i<32;i++)tokens.add(workers.submit(()->PendingIntent.getBroadcast(application,8,message,PendingIntent.FLAG_IMMUTABLE)));
    PendingIntent shared=tokens.get(0).get();for(var token:tokens)check(shared.equals(token.get()),"concurrent factories share original token identity");shared.cancel();
   }
  }finally{HostJobScheduler.hostShutdown();maclauncher.android.bridge.LocalBroadcasts.shutdown();HostWindowManager.shutdown();HostApplication.shutdown();FrameworkResources.shutdown();HostLooper.close(loop);}
  System.out.println("PASS upstream job service, original callback dispatch, bounded replacement, raw PendingIntent parcel and broadcast lifetime");
 }
}
