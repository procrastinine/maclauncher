package maclauncher.android;

import maclauncher.android.framework.*;
import maclauncher.android.fixture.RuntimeFixture;
import android.content.pm.ApplicationInfo;
import java.nio.file.*;
import java.util.*;

/** System-package classification is installation state, never an account bypass. */
public final class PlatformPackageProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        var loop=RuntimeFixture.initialize(args[0],args[1]);System.load(System.getProperty("klepton.graphics"));
        HostProcessIdentity.configure(1000,(int)new com.sun.security.auth.module.UnixSystem().getUid());
        Path framework=Path.of(args[0],"android-framework.jar").toRealPath();
        FrameworkResources.configure(framework,List.of(framework));
        try{
            HostContext.hostPackage("android","16",1);
            HostContext.hostApplicationInfo(0,framework.toString(),args[1],args[1],0);
            HostContext.hostApplicationIdentity(1000,0);HostPackages.inspectSources(List.of(framework));
            var application=HostContext.hostApplicationInfoSnapshot();
            check(application.uid==1000&&(application.flags&ApplicationInfo.FLAG_SYSTEM)!=0,"original platform ApplicationInfo is system-owned");
            var info=HostPackages.service().getPackageInfo("android",0,0);
            check(info.applicationInfo.uid==1000&&(info.applicationInfo.flags&ApplicationInfo.FLAG_SYSTEM)!=0,"original PackageInfo retains system installation state");
            Path apk=Path.of(args[1],"ordinary.apk");SyntheticResources.apk(apk,"","Ordinary package",null);maclauncher.android.fixture.PackageManifest.add(apk,"window");
            FrameworkResources.shutdown();FrameworkResources.configure(framework,List.of(apk));
            HostContext.hostPackage("org.example.window","1",1);HostContext.hostApplicationInfo(false,apk.toString(),args[1],args[1],28);HostContext.hostApplicationIdentity(1000,0);HostPackages.inspectSources(List.of(apk));
            check((HostContext.hostApplicationInfoSnapshot().flags&ApplicationInfo.FLAG_SYSTEM)==0,"a UID alone cannot make an ordinary APK a system package");
            System.out.println("PASS original platform package system state and ordinary package isolation");
        }finally{HostPackages.hostClearProviders();HostContext.hostShutdown();FrameworkResources.shutdown();HostLooper.close(loop);}
    }
}
