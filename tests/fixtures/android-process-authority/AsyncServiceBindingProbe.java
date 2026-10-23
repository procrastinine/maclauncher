package maclauncher.android.framework;

import android.app.IActivityManager;
import android.app.IServiceConnection;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import java.lang.reflect.Field;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import maclauncher.android.fixture.RuntimeFixture;

/** Startup, cancellation and death races use the original Android Binder APIs. */
public final class AsyncServiceBindingProbe {
    private static HostProcessServices owner;
    private static volatile boolean callbackUnderOwnerLock;
    private static final Context context=new ContextWrapper(null){
        @Override public String getPackageName(){return "fixture.caller";}
        @Override public int getUserId(){return 0;}
        @Override public ContentResolver getContentResolver(){return null;}
    };
    private static final class Client extends IServiceConnection.Stub {
        final CountDownLatch notified=new CountDownLatch(1);volatile boolean dead;volatile IBinder service;
        @Override public void connected(ComponentName name,IBinder service,boolean dead){if(Thread.holdsLock(owner))callbackUnderOwnerLock=true;this.dead=dead;this.service=service;notified.countDown();}
    }
    private static final class Manager extends IActivityManager.Default {
        final IBinder binder=new Binder(){{attachInterface(Manager.this,"android.app.IActivityManager");}};
        final IBinder endpoint=new Binder();final AtomicInteger binds=new AtomicInteger(),unbinds=new AtomicInteger();
        CountDownLatch entered,release;
        @Override public IBinder asBinder(){return binder;}
        @Override public int bindService(android.app.IApplicationThread caller,IBinder token,Intent intent,String type,IServiceConnection connection,long flags,String packageName,int user)throws RemoteException{
            binds.incrementAndGet();if(entered!=null){entered.countDown();try{if(!release.await(5,TimeUnit.SECONDS))throw new AssertionError("Bind race did not release");}catch(InterruptedException interrupted){throw new AssertionError(interrupted);}}
            connection.connected(intent.getComponent(),endpoint,false);return 1;
        }
        @Override public boolean unbindService(IServiceConnection connection){unbinds.incrementAndGet();return true;}
    }
    private static ServiceInfo info(String name){var info=new ServiceInfo();info.packageName="fixture."+name;info.processName=info.packageName;info.name=info.packageName+".Service";return info;}
    private static Intent intent(ServiceInfo info){return new Intent().setComponent(new ComponentName(info.packageName,info.name));}
    @SuppressWarnings("unchecked")
    private static void ready(HostProcessServices.Process process,Manager manager)throws Exception{ready(process,Context.ACTIVITY_SERVICE,manager.asBinder());}
    @SuppressWarnings("unchecked")
    private static void ready(HostProcessServices.Process process,String expected,IBinder binder)throws Exception{
        Field field=process.getClass().getDeclaredField("directory");field.setAccessible(true);
        ((CompletableFuture<IServiceManager>)field.get(process)).complete(new IServiceManager.Default(){@Override public IBinder checkService(String name){if(!expected.equals(name))throw new AssertionError(name);return binder;}});
    }
    private static void await(CountDownLatch latch,String message)throws Exception{if(!latch.await(5,TimeUnit.SECONDS))throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        RuntimeFixture.initialize(args[0],args[1]);
        Field field=HostRemoteServices.class.getDeclaredField("processes");field.setAccessible(true);
        HostProcessServices processes=(HostProcessServices)field.get(null);owner=processes;AtomicInteger requests=new AtomicInteger();processes.resolver(key->requests.incrementAndGet());
        try{
            ServiceInfo cold=info("cold");Client client=new Client();Manager manager=new Manager();long start=System.nanoTime();
            if(!HostRemoteServices.bind(context,cold,intent(cold),client,Context.BIND_AUTO_CREATE))throw new AssertionError("Cold service was rejected");
            if(System.nanoTime()-start>250_000_000L)throw new AssertionError("Binding waited for provider startup");
            if(client.notified.getCount()!=1||manager.binds.get()!=0)throw new AssertionError("Callback ran before provider startup");
            ready(processes.find(cold),manager);await(client.notified,"Service did not connect after startup");
            if(client.dead||client.service!=manager.endpoint)throw new AssertionError("Original connection callback changed");
            if(!HostRemoteServices.unbind(client))throw new AssertionError("Connected service did not retire");

            ServiceInfo cancelled=info("cancelled");Client cancelledClient=new Client();Manager cancelledManager=new Manager();
            HostRemoteServices.bind(context,cancelled,intent(cancelled),cancelledClient,Context.BIND_AUTO_CREATE);
            if(!HostRemoteServices.unbind(cancelledClient))throw new AssertionError("Pending bind could not unbind");
            ready(processes.find(cancelled),cancelledManager);
            processes.find(cancelled).serviceAsync(Context.ACTIVITY_SERVICE).toCompletableFuture().get(5,TimeUnit.SECONDS);
            if(cancelledManager.binds.get()!=0||cancelledClient.notified.getCount()!=1)throw new AssertionError("Cancelled startup revived a binding");

            ServiceInfo failed=info("failed");Client failedClient=new Client();
            HostRemoteServices.bind(context,failed,intent(failed),failedClient,Context.BIND_AUTO_CREATE);
            processes.unavailable(failed.packageName,failed.processName);await(failedClient.notified,"Provider death did not notify client");
            if(!failedClient.dead)throw new AssertionError("Provider death became a null binding");HostRemoteServices.unbind(failedClient);

            ServiceInfo racing=info("racing");Client racingClient=new Client();Manager racingManager=new Manager();racingManager.entered=new CountDownLatch(1);racingManager.release=new CountDownLatch(1);
            HostRemoteServices.bind(context,racing,intent(racing),racingClient,Context.BIND_AUTO_CREATE);ready(processes.find(racing),racingManager);
            await(racingManager.entered,"Remote bind did not begin");HostRemoteServices.unbind(racingClient);racingManager.release.countDown();
            await(racingClient.notified,"In-flight remote bind did not return");long until=System.nanoTime()+5_000_000_000L;
            while(racingManager.unbinds.get()==0&&System.nanoTime()<until)Thread.sleep(1);
            if(racingManager.unbinds.get()!=1)throw new AssertionError("Late remote binding survived unbind");
            android.content.pm.ActivityInfo activity=new android.content.pm.ActivityInfo();activity.packageName="fixture.activity";activity.processName=activity.packageName;
            start=System.nanoTime();var activityTask=HostRemoteServices.activityTasksAsync(activity).toCompletableFuture();
            if(activityTask.isDone()||System.nanoTime()-start>250_000_000L)throw new AssertionError("Activity routing waited for process startup");
            android.app.IActivityTaskManager task=new android.app.IActivityTaskManager.Default();Binder taskBinder=new Binder();taskBinder.attachInterface(task,"android.app.IActivityTaskManager");
            ready(processes.find(activity.packageName,activity.processName),Context.ACTIVITY_TASK_SERVICE,taskBinder);
            if(activityTask.get(5,TimeUnit.SECONDS)!=task)throw new AssertionError("Activity destination changed after startup");
            if(manager.unbinds.get()!=1)throw new AssertionError("Connected service unbind was lost");
            if(requests.get()!=5)throw new AssertionError("Unexpected process activation count: "+requests);
            if(callbackUnderOwnerLock)throw new AssertionError("Connection callback held the process owner lock");
            System.out.println("PASS asynchronous service activation, original callbacks, cancellation, death and late-unbind ownership");
        }finally{HostRemoteServices.shutdown();HostLooper.close(Looper.getMainLooper());HostContext.hostShutdown();}
    }
}
