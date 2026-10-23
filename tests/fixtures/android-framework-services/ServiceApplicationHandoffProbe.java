package maclauncher.android.fixture;

import android.app.*;
import android.content.*;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import maclauncher.android.framework.*;

/** Original objects and dispatchers; a caller Context cannot choose the service Application. */
public final class ServiceApplicationHandoffProbe {
    static Application application;
    static final Application decoy=new Application();
    static final List<String> order=new ArrayList<>();
    static Intent intent;
    static Context misleading;
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static void drain(Looper loop){HostLooper.drain(loop);HostLooper.drain(loop);}
    static Application selected(ComponentName name)throws Exception {
        var method=HostApplication.class.getDeclaredMethod("serviceApplication",ComponentName.class);method.setAccessible(true);
        try{return (Application)method.invoke(null,name);}catch(java.lang.reflect.InvocationTargetException failure){if(failure.getCause() instanceof RuntimeException error)throw error;if(failure.getCause() instanceof Error error)throw error;throw failure;}
    }
    static android.content.pm.ApplicationInfo originalInfo()throws Exception {
        var method=HostApplication.class.getDeclaredMethod("current");method.setAccessible(true);Object process=method.invoke(null);
        var field=process.getClass().getDeclaredField("apk");field.setAccessible(true);return ((LoadedApk)field.get(process)).getApplicationInfo();
    }
    static Application entryApplication;
    static int realConstructed,realAttached,realCreated,connected;
    static final Map<ServiceConnection,Context> earlyConnections=new LinkedHashMap<>();
    static void earlyBind(Context context){
        ServiceConnection connection=new ServiceConnection(){public void onServiceConnected(ComponentName name,IBinder binder){check(binder==JobSchedulerProbe.local.binder,"original early binding binder");connected++;}public void onServiceDisconnected(ComponentName name){throw new AssertionError("unexpected early disconnect");}};
        try{Class<?> implType=Class.forName("android.app.ContextImpl");var implMethod=implType.getDeclaredMethod("getImpl",Context.class);implMethod.setAccessible(true);Object impl=implMethod.invoke(null,context);var outer=implType.getDeclaredMethod("getOuterContext");outer.setAccessible(true);Context dispatchOwner=(Context)outer.invoke(impl);
            check(context.bindService(intent,connection,Context.BIND_AUTO_CREATE),"early original Context bind accepted");earlyConnections.put(connection,dispatchOwner);
        }catch(ReflectiveOperationException failure){throw new AssertionError(failure);}
    }
    static LoadedApk boundApk()throws Exception {
        ActivityThread thread=ActivityThread.currentActivityThread();var bound=thread.getClass().getDeclaredField("mBoundApplication");bound.setAccessible(true);Object record=bound.get(thread);var info=record.getClass().getDeclaredField("info");info.setAccessible(true);return (LoadedApk)info.get(record);
    }
    static Object originalGet(Object owner,Class<?> type,String name)throws Exception {var field=type.getDeclaredField(name);field.setAccessible(true);return field.get(owner);}
    static void originalField(Object owner,Class<?> type,String name,Object value)throws Exception {var field=type.getDeclaredField(name);field.setAccessible(true);field.set(owner,value);}
    public static final class App extends Application {
        @Override protected void attachBaseContext(Context base){
            super.attachBaseContext(base);misleading=new ContextWrapper(base){@Override public Context getApplicationContext(){return decoy;}};
            check(HostLocalServices.start(misleading,intent).equals(intent.getComponent()),"service queues during original Instrumentation attachment");
            check(JobSchedulerProbe.localEvents.isEmpty(),"queued service does not run during attach");order.add("queued-before-adopt");
        }
        @Override public void onCreate(){
            try{
                LoadedApk apk=boundApk();
                // Original Instrumentation attaches the replacement exactly once. Publish the
                // same original records as ActivityThread/HostApplication.adopt; retain the entry
                // cache to expose a stale shadow. This is not full LoadedApk.makeApplicationInner.
                ActivityThread thread=ActivityThread.currentActivityThread();
                Instrumentation instrumentation=(Instrumentation)originalGet(thread,ActivityThread.class,"mInstrumentation");
                Class<?> contextType=Class.forName("android.app.ContextImpl");var make=contextType.getDeclaredMethod("createAppContext",ActivityThread.class,LoadedApk.class);make.setAccessible(true);Context actualContext=(Context)make.invoke(null,thread,apk);
                application=instrumentation.newApplication(apk.getClassLoader(),Real.class.getName(),actualContext);JobSchedulerProbe.application=application;
                var outer=contextType.getDeclaredMethod("setOuterContext",Context.class);outer.setAccessible(true);outer.invoke(actualContext,application);
                originalField(apk,LoadedApk.class,"mApplication",application);
                originalField(thread,ActivityThread.class,"mInitialApplication",application);
                @SuppressWarnings("unchecked")List<Application> applications=(List<Application>)originalGet(thread,ActivityThread.class,"mAllApplications");applications.remove(entryApplication);applications.add(application);
                application.onCreate();
            }catch(Exception failure){throw new RuntimeException(failure);}
        }
    }
    public static final class Real extends Application {
        public Real(){realConstructed++;}
        @Override protected void attachBaseContext(Context base){super.attachBaseContext(base);realAttached++;earlyBind(base);}
        @Override public void onCreate(){realCreated++;earlyBind(this);}
    }
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]).toRealPath(),data=Path.of(args[1]).toRealPath(),apk=data.resolve("jobs.apk");
        try(var zip=new ZipOutputStream(Files.newOutputStream(apk))){zip.putNextEntry(new ZipEntry("assets/value"));zip.write(1);zip.closeEntry();}
        PackageManifest.add(apk,"jobs");
        String pkg="owned.jobs";
        HostFilesystem.configure(runtime,data,data,data,pkg);
        for(String kind:List.of("bridge","graphics","audio"))System.setProperty("klepton."+kind,runtime.resolve("native/libklepton-"+(kind.equals("bridge")?"jvm":kind)+".dylib").toString());
        System.load(System.getProperty("klepton.bridge"));System.load(runtime.resolve("native/libnativebinding.dylib").toString());
        if(System.getenv("KL_ANDROID_ID_DIRECTORY")!=null)HostProcessIdentity.initializeIds();
        maclauncher.android.framework.JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));maclauncher.android.framework.JvmNativeMemory.initialize();
        maclauncher.android.bridge.Bridge.configure(data.toString(),data.toString());
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
        HostContext.hostPackage(pkg,"1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);
        HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostContext.hostClassLoader(ServiceApplicationHandoffProbe.class.getClassLoader());
        Looper loop=HostLooper.main();HostPackages.inspectSources(List.of(apk));HostApplication.prepare(ServiceApplicationHandoffProbe.class.getClassLoader());Context context=HostApplication.applicationContext();
        JobSchedulerProbe.owner=Thread.currentThread();intent=new Intent().setComponent(new ComponentName(pkg,JobSchedulerProbe.Plain.class.getName()));
        try {
            entryApplication=HostApplication.instantiate(ServiceApplicationHandoffProbe.class.getClassLoader(),App.class.getName());
            HostApplication.create(entryApplication);order.add("adopted");
            check(application!=entryApplication&&ActivityThread.currentApplication()==application,"original records retain the actual replacement Application");
            check(realConstructed==1&&realAttached==1&&realCreated==1,"original LoadedApk creator attaches and creates exactly once");
            check(application.getApplicationContext()==application,"original ContextImpl points to adopted application");
            drain(loop);
            check(JobSchedulerProbe.local.getApplication()==application&&JobSchedulerProbe.local.getApplication()!=decoy,"resolved service uses exact original application");
            check(JobSchedulerProbe.localEvents.subList(0,2).equals(List.of("create","start"))&&connected==2,"normal service order and both early original Context callbacks");
            try{HostApplication.attachService(new JobSchedulerProbe.Plain(),entryApplication);throw new AssertionError("stale initial entry instance accepted");}catch(IllegalArgumentException expected){}
            // Original ServiceDispatcher owns the Context identity captured at bind time;
            // the attach-time ContextImpl outer changes only after Instrumentation returns.
            for(var early:earlyConnections.entrySet())ActivityManager.getService().unbindService(boundApk().forgetServiceDispatcher(early.getValue(),early.getKey()));earlyConnections.clear();drain(loop);
            var running=HostLocalServices.running(10);check(running.size()==1&&running.getFirst().uid==application.getApplicationInfo().uid&&running.getFirst().service.equals(intent.getComponent()),"running service identity retains resolved package and UID");
            int[] connected={0};ServiceConnection connection=new ServiceConnection(){public void onServiceConnected(ComponentName name,IBinder binder){check(binder==JobSchedulerProbe.local.binder,"original dispatcher carries service binder");connected[0]++;}public void onServiceDisconnected(ComponentName name){throw new AssertionError("unexpected disconnect");}};
            check(application.bindService(intent,connection,Context.BIND_AUTO_CREATE),"second context binds existing original service");drain(loop);check(connected[0]==1,"first original service callback completes before unbind");
            application.unbindService(connection);drain(loop);
            check(application.bindService(intent,connection,Context.BIND_AUTO_CREATE),"original rebind accepted");drain(loop);
            check(connected[0]==2&&JobSchedulerProbe.localEvents.getLast().equals("rebind"),"rebind preserves service and original application");
            LoadedApk original=boundApk();originalField(original,LoadedApk.class,"mApplication",null);
            try{selected(intent.getComponent());throw new AssertionError("absent original Application accepted");}catch(IllegalStateException expected){check(expected.getMessage().equals("The bound LoadedApk has no attached Application"),"missing original owner is explicit");}finally{originalField(original,LoadedApk.class,"mApplication",application);}
            check(realConstructed==1&&realAttached==1,"resolver never manufactures or reattaches an Application");
            try{HostApplication.attachService(new JobSchedulerProbe.Plain(),decoy);throw new AssertionError("foreign instance accepted");}catch(IllegalArgumentException expected){check(expected.getMessage().equals("Service belongs to another application"),"exact application guard retained");}
            try{selected(new ComponentName("foreign.package",intent.getComponent().getClassName()));throw new AssertionError("foreign package accepted");}catch(SecurityException expected){}
            String process=HostContext.hostProcessName();HostContext.hostProcessName(process+":foreign");
            try{selected(intent.getComponent());throw new AssertionError("foreign process accepted");}catch(SecurityException expected){}finally{HostContext.hostProcessName(process);}
            var own=originalInfo();int uid=own.uid;own.uid=uid+1;
            try{selected(intent.getComponent());throw new AssertionError("mismatched UID accepted");}catch(SecurityException expected){}finally{own.uid=uid;}
            application.unbindService(connection);for(var early:earlyConnections.entrySet())ActivityManager.getService().unbindService(boundApk().forgetServiceDispatcher(early.getValue(),early.getKey()));drain(loop);check(application.stopService(intent),"service stop accepted");drain(loop);
            check(JobSchedulerProbe.localEvents.getLast().equals("destroy")&&HostLocalServices.running(10).isEmpty(),"original final service retirement");
            int events=JobSchedulerProbe.localEvents.size();check(HostLocalServices.start(misleading,intent)!=null,"new pending local start accepted");HostLocalServices.shutdown();drain(loop);
            check(JobSchedulerProbe.localEvents.size()==events&&HostLocalServices.running(10).isEmpty(),"shutdown drops queued create without callbacks");
            check(order.equals(List.of("queued-before-adopt","adopted")),"service registration/adoption order");
            System.out.println("PASS original ART-shaped instantiate/create, LoadedApk Application handoff, attach/onCreate queued binds, exact active instance guards and retirement");
        } finally {HostApplication.shutdown();FrameworkResources.shutdown();HostLooper.close(loop);}
        System.exit(0);
    }
}
