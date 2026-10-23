import android.app.*;
import android.content.*;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.*;
import maclauncher.android.fixture.RuntimeFixture;

/** Real lifecycle calls and the unchanged client exercise the shared owner. */
public final class RunningServicesProbe {
    static int factoryCalls;
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static final class ReplacementService extends owned.packages.Service {}
    public static final class Factory extends AppComponentFactory {
        @Override public android.app.Service instantiateService(ClassLoader loader,String name,Intent intent){
            check(loader==RunningServicesProbe.class.getClassLoader(),"original LoadedApk supplies the service loader");
            check(name.equals("owned.packages.Service")&&intent.getComponent().getClassName().equals(name)&&"fixture.START".equals(intent.getAction()),"factory retains the declared service and original Intent");
            factoryCalls++;return new ReplacementService();
        }
    }
    public static void main(String[] args)throws Exception{
        Looper loop=RuntimeFixture.initialize(args[0],args[1]);
        System.load(System.getProperty("klepton.graphics"));
        Path data=Path.of(args[1]),apk=data.resolve("service.apk");
        maclauncher.android.fixture.PackageManifest.add(apk,"package");
        FrameworkResources.configure(Path.of(args[0],"android-framework.jar"),List.of(apk));
        HostContext.hostPackage("owned.packages","1.2",12);
        HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),35);
        HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
        HostPackages.inspectSources(List.of(apk));
        var metadata=HostContext.hostApplicationInfoSnapshot();metadata.appComponentFactory=Factory.class.getName();
        var adopt=HostContext.class.getDeclaredMethod("adoptApplicationInfo",android.content.pm.ApplicationInfo.class,Bundle.class);adopt.setAccessible(true);adopt.invoke(null,metadata,metadata.metaData);
        HostApplication.prepare(RunningServicesProbe.class.getClassLoader());
        Context context=HostApplication.applicationContext();Application application=new Application();HostApplication.attach(application,context);
        Context overridden=new ContextWrapper(context){@Override public String getPackageName(){return "fixture.context.wrapper";}};
        ActivityManager manager=context.getSystemService(ActivityManager.class);
        try{
            check(manager.getRunningServices(10).isEmpty()&&owned.packages.Service.created==0,"query must not start a service");
            Intent intent=new Intent("fixture.START").setComponent(new ComponentName("owned.packages","owned.packages.Service"));
            long before=SystemClock.elapsedRealtime(),activity=SystemClock.uptimeMillis();
            check(HostLocalServices.start(overridden,intent)!=null,"declared local service starts with an overridden Context package");HostLooper.drain(loop);
            check(context.startService(intent)!=null,"original Context service client starts the same owner");HostLooper.drain(loop);
            List<ActivityManager.RunningServiceInfo> running=manager.getRunningServices(10);
            check(running.size()==1&&owned.packages.Service.created==1,"existing service is observed once");
            check(factoryCalls==1&&owned.packages.Service.instance instanceof ReplacementService,"original factory substitution creates the Service exactly once");
            var info=running.get(0);
            check(info.service.equals(intent.getComponent())&&info.uid==android.os.Process.myUid()&&info.pid==android.os.Process.myPid()&&info.process.equals(HostContext.hostProcessName()),"actual Android service identity");
            check(info.started&&!info.foreground&&info.flags==ActivityManager.RunningServiceInfo.FLAG_STARTED&&info.clientCount==0,"started lifecycle flags");
            check(info.activeSince>=before&&info.activeSince<=SystemClock.elapsedRealtime()&&info.lastActivityTime>=activity&&info.lastActivityTime<=SystemClock.uptimeMillis(),"Android clock domains");
            check(manager.getRunningServices(0).isEmpty()&&manager.getRunningServices(-1).isEmpty()&&manager.getRunningServices(1).size()==1,"query bounds");
            info.started=false;running.clear();check(manager.getRunningServices(1).get(0).started,"caller snapshot cannot modify lifecycle");
            int[] connected={0};ServiceConnection connection=new ServiceConnection(){public void onServiceConnected(ComponentName name,IBinder service){connected[0]++;}public void onServiceDisconnected(ComponentName name){}};
            check(context.bindService(intent,connection,Context.BIND_AUTO_CREATE),"original bind accepted");HostLooper.drain(loop);HostLooper.drain(loop);
            info=manager.getRunningServices(1).get(0);check(connected[0]==1&&info.clientCount==1&&info.started,"original bind and live client count: "+connected[0]+"/"+info.clientCount+"/"+info.started);
            int[] wrappedConnected={0};var wrappedConnection=new IServiceConnection.Stub(){@Override public void connected(ComponentName name,IBinder binder,boolean dead){check(name.equals(intent.getComponent())&&binder!=null&&!dead,"wrapped service binding retains its original endpoint");wrappedConnected[0]++;}};
            check(HostLocalServices.bind(overridden,intent,wrappedConnection,Context.BIND_AUTO_CREATE),"declared local service binds with an overridden Context package");HostLooper.drain(loop);
            check(wrappedConnected[0]==1&&manager.getRunningServices(1).get(0).clientCount==2,"wrapped binding shares the original Service lifecycle");
            HostLocalServices.unbind(wrappedConnection);HostLooper.drain(loop);
            owned.packages.Service.instance.startForeground(41,new Notification.Builder(context,"fixture").setContentTitle("Service fixture").setSmallIcon(android.R.drawable.ic_dialog_info).build());HostLooper.drain(loop);
            info=manager.getRunningServices(1).get(0);check(info.foreground&&(info.flags&ActivityManager.RunningServiceInfo.FLAG_FOREGROUND)!=0,"original foreground transition");
            owned.packages.Service.instance.stopForeground(android.app.Service.STOP_FOREGROUND_REMOVE);HostLooper.drain(loop);
            check(!manager.getRunningServices(1).get(0).foreground,"original foreground retirement");
            Parcel parcel=Parcel.obtain();try{info.writeToParcel(parcel,0);parcel.setDataPosition(0);var copy=ActivityManager.RunningServiceInfo.CREATOR.createFromParcel(parcel);check(copy.service.equals(info.service)&&copy.clientCount==1&&copy.activeSince==info.activeSince,"unchanged Parcelable record");}finally{parcel.recycle();}
            owned.packages.Service.instance.stopSelf();HostLooper.drain(loop);
            check(!manager.getRunningServices(1).get(0).started,"factory-substituted Service.stopSelf retains the declared component name");
            check(HostLocalServices.stop(overridden,intent),"service stop accepts an overridden Context package");HostLooper.drain(loop);
            info=manager.getRunningServices(1).get(0);check(!info.started&&info.clientCount==1&&info.flags==0&&owned.packages.Service.destroyed==0,"bound service remains after stop");
            context.unbindService(connection);HostLooper.drain(loop);
            check(manager.getRunningServices(10).isEmpty()&&owned.packages.Service.destroyed==1,"last client retires service");
        }finally{HostApplication.shutdown();HostLooper.drain(loop);FrameworkResources.shutdown();HostLooper.close(loop);HostContext.hostShutdown();}
        System.out.println("PASS original ActivityManager running-service start, bind, identity, parcel and retirement");
    }
}
