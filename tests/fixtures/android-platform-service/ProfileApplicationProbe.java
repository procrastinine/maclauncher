package maclauncher.android;

import android.app.*;
import android.content.Context;
import android.os.*;
import android.provider.Settings;
import java.nio.file.*;
import java.util.List;
import maclauncher.android.framework.*;

/** Original application APIs after real profile directories have connected. */
public final class ProfileApplicationProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Path.of(args[1]);String name=args[2];
        Path files=Files.createDirectories(data.resolve("files")),cache=Files.createDirectories(data.resolve("cache"));
        RuntimeBootstrap.initialize(runtime,data,files,cache,name,false,false,false);
        Looper loop=null;
        // The launcher enrolls this package with the profile catalog after the
        // process identity hello, so its APK exists before authority is read.
        Path apk=data.resolve("owned.apk");SyntheticResources.apk(apk,"","Window",null);maclauncher.android.fixture.PackageManifest.add(apk,"window");
        try(var authority=ProcessAuthority.read(5,name,name)) {
            HostProcessIdentity.configure(authority.self.uid(),authority.self.hostUid());
            authority.attachPlatform();
            // Exercise the same early singleton lookup that framework/SDK startup
            // may perform before the application's own Activity service exists.
            IBinder before=ServiceManager.checkService(Context.ACTIVITY_SERVICE);
            IActivityManager early=ActivityManager.getService();
            System.out.println("early activity endpoint="+(before==null?"absent":before.getInterfaceDescriptor()+" owner="+HostBinderRpc.ownerOf(before)+" local="+(before.queryLocalInterface("android.app.IActivityManager")!=null)));
            FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
            HostContext.hostPackage(name,"1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);
            HostContext.hostApplicationIdentity(authority.self.uid(),0);HostContext.hostFilesDirectory(files.toString());HostContext.hostCacheDirectory(cache.toString());HostContext.hostClassLoader(ProfileApplicationProbe.class.getClassLoader());
            loop=HostLooper.main();HostPackages.inspectSources(List.of(apk));HostDisplay.hostPublish(1,320,240,60);HostDisplayEvents.hostSetWakeup(()->{});
            HostApplication.prepare(ProfileApplicationProbe.class.getClassLoader());Context context=HostApplication.applicationContext();Application app=new Application();HostApplication.attach(app,context);HostApplication.create(app);
            IBinder local=HostServices.manager().checkService(Context.ACTIVITY_SERVICE),actual=ActivityManager.getService().asBinder();
            System.out.println("prepared activity local="+(actual==local)+" owner="+HostBinderRpc.ownerOf(actual)+" directoryOwner="+(local==null?"absent":HostBinderRpc.ownerOf(local))+" actualLocal="+(actual.queryLocalInterface("android.app.IActivityManager")!=null)+" directoryLocal="+(local!=null&&local.queryLocalInterface("android.app.IActivityManager")!=null)+" actual="+actual.getClass().getName()+" directory="+(local==null?"null":local.getClass().getName()));
            // The singleton holds the typed local client boundary for the registered
            // service binder; both are this process's own objects, never a remote owner.
            check(local!=null&&HostBinderRpc.ownerOf(local)==null&&local.queryLocalInterface("android.app.IActivityManager")!=null&&HostBinderRpc.ownerOf(actual)==null&&actual.queryLocalInterface("android.app.IActivityManager")!=null,"AOSP ActivityManager singleton must retain the application's local owner");
            // As on Android, an early lookup reaches the system ActivityManager; it
            // must never be another application's, and the prepared singleton above is local.
            var earlyOwner=before==null?null:HostBinderRpc.ownerOf(before);
            check(before==null||earlyOwner!=null&&earlyOwner.uid()==android.os.Process.SYSTEM_UID&&before.queryLocalInterface("android.app.IActivityManager")==null,"Profile directories publish only the system owner's ActivityManager");
            int value=Settings.Global.getInt(context.getContentResolver(),"maclauncher_fixture_absent_setting",-7);
            check(value==-7,"Original Settings.Global defaults must pass through a real provider");
            check(Settings.Global.getInt(context.getContentResolver(),Settings.Global.BOOT_COUNT)==Integer.parseInt(args[5]),"Original Settings reads the authenticated profile boot count");
            String identity=Settings.Secure.getString(context.getContentResolver(),Settings.Secure.ANDROID_ID);
            check(identity!=null&&identity.equals(Files.readString(data.resolve("system/android-id"))),"Settings provider must use this application's private identity");
            HostWindowProbe.OwnedActivity activity=new HostWindowProbe.OwnedActivity();
            HostActivity.attach(activity,context,app);
            try{check(activity.getWindow().getClass().getName().equals("com.android.internal.policy.PhoneWindow"),"Activity.attach must construct original PhoneWindow");}
            finally{HostActivity.finish(activity);}
            // The private lifecycle owner must coexist with both real remote directories.
            check(ServiceManager.getService("dropbox")!=null,"Original profile system service remains reachable");
            var usb=context.getSystemService(android.hardware.usb.UsbManager.class);
            check(usb!=null&&usb.getDeviceList().isEmpty()&&usb.getAccessoryList()==null,"Original USB client queries the profile owner without inventing a hardware transport");
            var accessory=new android.hardware.usb.UsbAccessory("Example","Permission fixture","Test-only accessory","1",null,"fixture");
            check(!usb.hasPermission(accessory),"An ordinary application has no invented USB grant");
            try{android.hardware.usb.IUsbManager.Stub.asInterface(ServiceManager.getService(Context.USB_SERVICE)).grantAccessoryPermission(accessory,authority.self.uid());throw new AssertionError("An ordinary application granted itself USB permission");}
            catch(SecurityException expected){}
            var keys=java.security.KeyStore.getInstance("AndroidKeyStore");keys.load(null);
            check(!keys.containsAlias("system-service-coexistence"),"Profile KeyStore preserves this application's UID");
            System.out.println("PASS original application Settings, ActivityManager and PhoneWindow with shared profile services");
        }finally{HostApplication.shutdown();if(loop!=null)HostLooper.close(loop);FrameworkResources.shutdown();HostRemoteServices.shutdown();}
        System.exit(0);
    }
}
