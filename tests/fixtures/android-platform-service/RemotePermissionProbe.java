package maclauncher.android.framework;

import android.app.Application;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import maclauncher.android.location.ManualLocation;
import maclauncher.android.media.MediaInputs;

/** Original permission endpoints on an authenticated app/native-service connection. */
public final class RemotePermissionProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args){try{run(args);System.exit(0);}catch(Throwable error){error.printStackTrace();System.exit(1);}}
    private static void run(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Files.createDirectories(Path.of(args[1]));boolean app=args[5].startsWith("app");int uid=app?10031:1000;
        var bootstrap=Class.forName("maclauncher.android.RuntimeBootstrap").getDeclaredMethod("initialize",Path.class,Path.class,Path.class,Path.class,String.class,boolean.class,boolean.class,boolean.class);bootstrap.setAccessible(true);
        bootstrap.invoke(null,runtime,data,Files.createDirectories(data.resolve("files")),Files.createDirectories(data.resolve("cache")),app?"org.example.permissions":"android",false,false,false);
        HostProcessIdentity.configure(uid,(int)new com.sun.security.auth.module.UnixSystem().getUid());Looper loop=HostLooper.main();
        var input=new BufferedReader(new InputStreamReader(System.in));System.out.println("READY");System.out.flush();check("connect".equals(input.readLine()),"Enrollment precedes connection");
        var peer=new HostBinderRpc.Peer("android","android.system",Integer.parseInt(args[3]),1000,"u:r:system_server:s0");
        HostRemoteServices.attachPlatform(args[2],peer);
        if(app){
            Path apk=Path.of(args[4]);FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
            HostContext.hostPackage("org.example.permissions","1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),runtime.resolve("native").toString(),35);
            HostContext.hostApplicationIdentity(uid,0);HostPackages.inspectSources(List.of(apk));HostStorageService.install();MediaInputs.configure("","");
            HostApplication.prepare(RemotePermissionProbe.class.getClassLoader());HostApplication.attach(new Application(),HostApplication.applicationContext());
        }
        var permission=IPermissionController.Stub.asInterface(HostServices.platformService("permission"));
        var audio=android.media.IAudioService.Stub.asInterface(HostServices.platformService(Context.AUDIO_SERVICE));
        check(permission!=null&&audio!=null,"Canonical native endpoints exist");System.out.println("OK");System.out.flush();
        String line;while((line=input.readLine())!=null){
            switch(line){
                case "denied"->{
                    for(String name:List.of(android.Manifest.permission.CAMERA,android.Manifest.permission.RECORD_AUDIO,android.Manifest.permission.ACCESS_FINE_LOCATION))
                        check(!permission.checkPermission(name,0,10031),"Manifest/Off/absent grants remain denied: "+name);
                }
                case "grant"->{
                    check(app,"Only the app owns its manual-location decision");
                    // Simulate acceptance at the existing native-dialog completion seam; no host location access.
                    var handler=ManualLocation.class.getDeclaredField("main");handler.setAccessible(true);handler.set(null,new Handler(loop));
                    var active=ManualLocation.class.getDeclaredField("activeId");active.setAccessible(true);active.setLong(null,1);
                    ManualLocation.complete(1,new double[]{1,2,3});HostPermissions.notifyChanged();
                    check(HostPermissions.checkLocal(android.Manifest.permission.ACCESS_FINE_LOCATION,uid,0)==PackageManager.PERMISSION_GRANTED,"Original local owner holds the supplied decision");
                }
                case "granted"->check(permission.checkPermission(android.Manifest.permission.ACCESS_FINE_LOCATION,0,10031),"Native original client queries the enrolled app's current grant");
                case "revoke"->{check(app,"App-owned retirement");ManualLocation.hostShutdown();HostPermissions.notifyChanged();}
                case "barrier"->{
                    var work=Executors.newFixedThreadPool(4);try{List<Future<?>> pending=new ArrayList<>();for(int i=0;i<16;i++)pending.add(work.submit(()->{try{audio.getNativeInterface().permissionUpdateBarrier();}catch(RemoteException failure){throw new CompletionException(failure);}}));for(var future:pending)future.get(5,TimeUnit.SECONDS);}finally{work.shutdownNow();}
                }
                case "unauthorized"->{
                    check(!permission.checkPermission(android.Manifest.permission.ACCESS_SURFACE_FLINGER,0,10031),"Publication grants no native-service privileges");
                }
                case "stop"->{System.out.println("OK");System.out.flush();return;}
                default->throw new AssertionError(line);
            }
            System.out.println("OK");System.out.flush();
        }
    }
}
