package maclauncher.android;

import java.nio.file.*;
import maclauncher.android.framework.*;

/** A cold profile service component without an APK or application window. */
public final class PlatformStartupProbe {
    public static void main(String[] args){
        int status=0;
        try{
            Path runtime=Path.of(args[0]),data=Path.of(args[1]);
            Files.createDirectories(data.resolve("files"));Files.createDirectories(data.resolve("cache"));
            RuntimeBootstrap.initialize(runtime,data,data.resolve("files"),data.resolve("cache"),"android",false,false,false);
            HostProcessIdentity.configure(1000,(int)new com.sun.security.auth.module.UnixSystem().getUid());
            var looper=HostLooper.main();
            try(var services=HostSystemServices.start(runtime,data,"android.system")){
                if(android.os.Process.myUid()!=1000)throw new AssertionError("System identity changed");
                if(android.os.ServiceManager.checkService("permission")==null)throw new AssertionError("System permissions are unavailable");
                if(android.os.ServiceManager.listServices().length==0)throw new AssertionError("System services are unavailable");
                HostStartupTiming.mark("probe-ready");
                System.out.println("PASS cold platform service identity and directory");
            }finally{HostApplication.shutdown();HostLooper.close(looper);}
        }catch(Throwable failure){failure.printStackTrace();status=1;}
        System.exit(status);
    }
}
