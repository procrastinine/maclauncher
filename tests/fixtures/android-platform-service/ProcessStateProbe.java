package maclauncher.android;

import android.app.*;
import android.content.*;
import android.os.*;
import java.io.*;
import java.nio.file.*;
import maclauncher.android.framework.*;

/** Inherited-channel lifecycle and original remote query contract, without GUI input. */
public final class ProcessStateProbe {
    private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    public static void main(String[] args){try{run(args);System.exit(0);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
    private static void run(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Path.of(args[1]);String name=args[2];
        Path files=Files.createDirectories(data.resolve("files")),cache=Files.createDirectories(data.resolve("cache"));
        RuntimeBootstrap.initialize(runtime,data,files,cache,name,false,false,false);
        Looper loop=HostLooper.main();
        try(var authority=ProcessAuthority.read(5,name,name)){
            HostProcessIdentity.configure(authority.self.uid(),authority.self.hostUid());authority.attachPlatform();
            var activityManager=IActivityManager.Stub.asInterface(ServiceManager.getService("activity"));
            check(activityManager!=null,"Profile directory exports the existing complete ActivityManager dispatcher");
            var observer=new IUidObserver.Stub(){
                public void onUidStateChanged(int uid,int state,long sequence,int capabilities){}
                public void onUidGone(int uid,boolean disabled){}
                public void onUidActive(int uid){}public void onUidIdle(int uid,boolean disabled){}public void onUidCachedChanged(int uid,boolean cached){}public void onUidProcAdjChanged(int uid,int adj){}
            };
            var service=IProcessInfoService.Stub.asInterface(ServiceManager.getService("processinfo"));
            check(service!=null,"Original process-info service unavailable");
            var packages=android.content.pm.IPackageManagerNative.Stub.asInterface(ServiceManager.getService("package_native"));
            check(packages!=null&&name.equals(packages.getNamesForUids(new int[]{authority.self.uid()})[0]),"Native package client resolves the same enrolled UID");
            // attachPlatform started the authority reader. Production monitor()
            // needs the application context and reports the initial state, as here.
            ProcessAuthority.processStateChanged(HostActivityManager.hostUidProcessState(null,android.os.Process.myUid()));
            Activity activity=new Activity();
            System.out.println("READY");System.out.flush();
            var input=new BufferedReader(new InputStreamReader(System.in));String line;
            while((line=input.readLine())!=null){
                String[] fields=line.split(":");
                switch(fields[0]){
                    case "prepare"->{
                        check(ActivityManager.getService().asBinder()==activityManager.asBinder(),"Original client caches the shared owner before application binding");
                        Path framework=runtime.resolve("android-framework.jar"),apk=data.resolve("app.apk");
                        FrameworkResources.configure(framework,java.util.List.of(apk));HostContext.hostPackage(name,"1",1);
                        HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),runtime.resolve("native").toString(),36);
                        HostContext.hostApplicationIdentity(authority.self.uid(),0);HostContext.hostProcessName(name);HostPackages.inspectSources(java.util.List.of(apk));HostStorageService.install();
                        HostApplication.prepare(ProcessStateProbe.class.getClassLoader());
                        var context=HostApplication.applicationContext();
                        var local=ActivityManager.getService();check(local!=activityManager,"Original client adopts its local application owner");
                        var receiver=new BroadcastReceiver(){public void onReceive(Context ignored,Intent intent){}};
                        context.registerReceiverForAllUsers(receiver,new IntentFilter(Intent.ACTION_PACKAGE_ADDED),null,null);context.unregisterReceiver(receiver);
                        try{local.registerReceiverWithFeature(null,"unrelated.package",null,null,null,new IntentFilter(Intent.ACTION_PACKAGE_ADDED),null,0,0);throw new AssertionError("Local receiver package authorization weakened");}catch(SecurityException expected){}
                        check(HostServices.platformService(Context.ACTIVITY_SERVICE).equals(activityManager.asBinder()),"Shared UID endpoint remains independently available");
                    }
                    case "top"->HostActivityManager.hostStarted(activity);
                    case "background"->HostActivityManager.hostStopped(activity);
                    case "observe-denied"->{try{activityManager.registerUidObserver(observer,ActivityManager.UID_OBSERVER_PROCSTATE,ActivityManager.PROCESS_STATE_UNKNOWN,name);throw new AssertionError("Unprivileged UID observer accepted");}catch(SecurityException expected){}}
                    case "uid"->{
                        int uid=Integer.parseInt(fields[1]),expected=Integer.parseInt(fields[2]);
                        check(activityManager.getUidProcessState(uid,name)==expected,"Original UID query uses the same state owner");
                    }
                    case "query"->{
                        int pid=Integer.parseInt(fields[1]),expected=Integer.parseInt(fields[2]),states[]={-99};long until=System.nanoTime()+5_000_000_000L;
                        do{service.getProcessStatesFromPids(new int[]{pid},states);if(states[0]==expected)break;Thread.sleep(10);}while(System.nanoTime()<until);
                        check(states[0]==expected,"Actual PID state "+states[0]+" differs from "+expected);
                    }
                    case "invalid"->{try{service.getProcessStatesFromPids(new int[]{authority.self.pid()},new int[0]);throw new AssertionError("Mismatched arrays accepted");}catch(IllegalArgumentException expected){}}
                    case "scores"->{try{service.getProcessStatesAndOomScoresFromPids(new int[]{authority.self.pid()},new int[1],new int[1]);throw new AssertionError("Unprivileged OOM query accepted");}catch(SecurityException expected){}}
                    case "noscores"->{try{service.getProcessStatesAndOomScoresFromPids(new int[]{authority.self.pid()},new int[1],null);throw new AssertionError("Original remote out-array validation was bypassed");}catch(NullPointerException expected){}}
                    case "stop"->{activityManager.unregisterUidObserver(observer);System.out.println("OK");System.out.flush();return;}
                    default->throw new AssertionError("Unknown test command");
                }
                System.out.println("OK");System.out.flush();
            }
        }finally{HostApplication.shutdown();HostRemoteServices.shutdown();HostLooper.close(loop);FrameworkResources.shutdown();}
    }
}
