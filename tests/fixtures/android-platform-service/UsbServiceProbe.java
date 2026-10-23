package maclauncher.android;

import android.content.Context;
import android.hardware.usb.*;
import android.os.*;
import java.nio.file.*;
import maclauncher.android.framework.*;

public final class UsbServiceProbe {
    private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    public static void main(String[] args){try{run(args);System.exit(0);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
    private static void run(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Path.of(args[1]),files=Files.createDirectories(data.resolve("files")),cache=Files.createDirectories(data.resolve("cache"));
        RuntimeBootstrap.initialize(runtime,data,files,cache,"android.system",false,false,false);
        HostProcessIdentity.configure(android.os.Process.SYSTEM_UID,android.system.Os.getuid());
        Looper loop=HostLooper.main();
        try(var owner=HostSystemServices.start(runtime,data,"android.system")){
            Context context=HostApplication.applicationContext();
            UsbManager manager=context.getSystemService(UsbManager.class);
            check(manager!=null,"original USB manager published");
            check(manager.getDeviceList().isEmpty(),"no raw USB host transport is advertised");
            check(manager.getAccessoryList()==null,"no USB device-mode transport is advertised");
            IUsbManager service=IUsbManager.Stub.asInterface(ServiceManager.getService(Context.USB_SERVICE));
            check(HostServices.manager().checkService(Context.USB_SERVICE).queryLocalInterface(IUsbManager.class.getName()) instanceof com.android.server.usb.UsbService,"the service endpoint owns the original AOSP implementation");
            UsbAccessory accessory=new UsbAccessory("Example","Permission fixture","Test-only accessory","1",null,"fixture");
            int uid=10023,other=10024,pid=android.os.Process.myPid();
            if(args[2].equals("write")){
                check(!service.hasAccessoryPermissionWithIdentity(accessory,pid,uid),"ungranted UID rejected");
                service.grantAccessoryPermission(accessory,uid);
                check(service.hasAccessoryPermissionWithIdentity(accessory,pid,uid),"original transient grant");
                check(!service.hasAccessoryPermissionWithIdentity(accessory,pid,other),"another UID remains ungranted");
                service.setAccessoryPersistentPermission(accessory,uid,UserHandle.SYSTEM,true);
                service.setAccessoryPackage(accessory,"android",0);
                check(service.hasDefaults("android",0),"original accessory default recorded");
                Path permissions=Environment.getUserSystemDirectory(0).toPath().resolve("usb_permissions.xml");
                Path settings=Environment.getUserSystemDirectory(0).toPath().resolve("usb_device_manager.xml");
                long until=System.nanoTime()+java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
                while((!Files.isRegularFile(permissions)||!Files.isRegularFile(settings))&&System.nanoTime()<until){HostLooper.drain(loop);Thread.sleep(10);}
                check(Files.isRegularFile(permissions)&&Files.isRegularFile(settings),"original USB XML stores persisted");
            }else{
                check(service.hasAccessoryPermissionWithIdentity(accessory,pid,uid),"original permission survived process restart");
                check(!service.hasAccessoryPermissionWithIdentity(accessory,pid,other),"persistent grant is scoped to UID");
                check(service.hasDefaults("android",0),"original default survived process restart");
                service.clearDefaults("android",0);
                check(!service.hasDefaults("android",0),"original defaults can be cleared");
                service.setAccessoryPersistentPermission(accessory,uid,UserHandle.SYSTEM,false);
                check(!service.hasAccessoryPermissionWithIdentity(accessory,pid,uid),"original persistent permission revocation");
            }
        }finally{HostApplication.shutdown();HostLooper.close(loop);}
        System.out.println("PASS original USB discovery and UID permission ownership");
    }
}
