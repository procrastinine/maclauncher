package maclauncher.android.framework;

import android.app.*;
import android.content.*;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import org.json.*;
import maclauncher.android.fixture.RuntimeFixture;

/** Separate original LoadedApk applications inside one shared-UID process. */
public final class SharedPackageProcessProbe {
    public static final class SecondService extends android.app.Service {
        static int created;
        @Override public void onCreate(){if(!getPackageName().equals("fixture.second")||!getApplication().getPackageName().equals("fixture.second"))throw new AssertionError("Wrong package application");created++;}
        @Override public IBinder onBind(Intent intent){return new Binder();}
    }
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Files.createDirectories(Path.of(args[1])),first=Path.of(args[2]),second=Path.of(args[3]);
        var loop=RuntimeFixture.initialize(args[0],args[1],runtime.resolve("native/libklepton-graphics.dylib").toString());
        HostProcessIdentity.configure(10051,Integer.parseInt(args[4]));
        HostContext.hostPackage("fixture.first","1",1);HostContext.hostApplicationInfo(false,first.toString(),data.toString(),data.toString(),28);HostContext.hostApplicationIdentity(10051,0);
        HostContext.hostProcessName("fixture.shared");HostContext.hostClassLoader(SharedPackageProcessProbe.class.getClassLoader());
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(first));HostPackages.inspectSources(List.of(first));
        var peerData=Files.createDirectories(data.resolve("second"));
        var record=new JSONObject().put("packageName","fixture.second").put("sourceApks",new JSONArray().put(second.toString()))
            .put("nativeRoot",data.toString()).put("dataRoot",peerData.toString()).put("uid",10051).put("firstInstallTime",1).put("lastUpdateTime",1);
        HostPackages.inspectInstalled(new JSONArray().put(record).toString());HostStorageService.install();HostDisplay.hostPublish(1,320,240,60);
        var recording=new jdk.jfr.Recording();recording.enable("maclauncher.android.Application");recording.start();
        HostApplication.prepare(SharedPackageProcessProbe.class.getClassLoader());var context=HostApplication.applicationContext();
        var application=new Application();HostApplication.attach(application,context);HostApplication.create(application);
        try{
            Application secondApp=HostApplication.packageApplication("fixture.second");
            check(secondApp!=application&&secondApp.getPackageName().equals("fixture.second"),"Distinct original application");
            check(secondApp==HostApplication.packageApplication("fixture.second"),"Original LoadedApk caches application");
            check(secondApp.getApplicationInfo().uid==10051&&secondApp.getDataDir().toPath().equals(peerData),"Actual shared UID with package-private directory");
            var directory=new HostProcessServices();int[] requests={0};directory.resolver(key->requests[0]++);
            var pending=directory.find("fixture.second","fixture.shared");
            check(directory.find("fixture.first","fixture.shared")==pending&&requests[0]==1,"One process demand for two signed package aliases");
            var peer=new HostBinderRpc.Peer("fixture.first","fixture.shared",(int)ProcessHandle.current().pid(),10051);
            directory.expect(peer,"generation");check(directory.find(peer)==pending,"Authenticated canonical process adopts alias demand");directory.close();
            var intent=new Intent().setComponent(new ComponentName("fixture.second",SecondService.class.getName()));
            check(HostLocalServices.start(context,intent)!=null,"Second package resolves locally");HostLooper.drain(loop);
            check(SecondService.created==1,"Service uses second original Application");
            check(HostLocalServices.stop(context,intent),"Second package service retires");HostLooper.drain(loop);
            check(HostPackages.hostOwnsPackage("fixture.second",10051)&&!HostPackages.hostOwnsPackage("fixture.second",10052),"UID ownership remains exact");
            dalvik.system.VMDebug.removeApplication("fixture.second");recording.stop();var recordingFile=data.resolve("applications.jfr");recording.dump(recordingFile);
            var events=jdk.jfr.consumer.RecordingFile.readAllEvents(recordingFile).stream().filter(event->event.getEventType().getName().equals("maclauncher.android.Application")).toList();
            check(events.stream().filter(event->event.getBoolean("registered")).map(event->event.getString("packageName")).toList().equals(List.of("fixture.first","fixture.second")),"Original registration events reach actual JVM profiler once");
            check(events.size()==3&&!events.get(2).getBoolean("registered"),"Original unregister reaches actual JVM profiler");
            System.out.println("PASS shared process applications, service context, UID isolation and one directory demand");
        }finally{recording.close();HostApplication.shutdown();HostWindowManager.shutdown();HostDisplay.hostShutdown();HostDisplay.hostRemove();FrameworkResources.shutdown();HostLooper.close(loop);HostContext.hostShutdown();}
        System.exit(0);
    }
}
