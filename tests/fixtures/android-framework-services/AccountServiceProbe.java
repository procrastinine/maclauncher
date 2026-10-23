package maclauncher.android;

import android.accounts.*;
import android.app.Application;
import android.content.Context;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.*;

/** Original account service, original clients and private SQLite lifetime. */
public final class AccountServiceProbe {
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]).toRealPath(),data=Files.createDirectories(Path.of(args[1])).toRealPath();
        Path files=Files.createDirectories(data.resolve("files")),cache=Files.createDirectories(data.resolve("cache"));
        HostFilesystem.configure(runtime,data,files,cache,"org.example.window");
        System.setProperty("klepton.bridge",runtime.resolve("native/libklepton-jvm.dylib").toString());System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());System.setProperty("klepton.audio",runtime.resolve("native/libklepton-audio.dylib").toString());
        System.load(System.getProperty("klepton.bridge"));System.load(runtime.resolve("native/libnativebinding.dylib").toString());JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();HostStorageService.install();
        HostProcessIdentity.configure(10000,(int)new com.sun.security.auth.module.UnixSystem().getUid());
        Path apk=data.resolve("owned.apk");SyntheticResources.apk(apk,"","Accounts",null);maclauncher.android.fixture.PackageManifest.add(apk,"window");FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
        HostContext.hostPackage("org.example.window","1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostContext.hostFilesDirectory(files.toString());HostContext.hostCacheDirectory(cache.toString());ClassLoader guest=new ClassLoader(AccountServiceProbe.class.getClassLoader()){};HostContext.hostClassLoader(guest);HostPackages.inspectSources(List.of(apk));
        Looper loop=HostLooper.main();
        System.load(System.getProperty("klepton.graphics"));HostDisplay.initializeHeadless();
        var display=android.hardware.display.DisplayManagerGlobal.getInstance().getDisplayInfo(android.view.Display.DEFAULT_DISPLAY);
        if(display==null||display.logicalWidth<=0||display.logicalHeight<=0||display.getRefreshRate()<=0)throw new AssertionError("Headless process has no actual screen metadata");
        if(maclauncher.android.bridge.NativeSurface.statistics()[0]!=0)throw new AssertionError("Headless display observation allocated a native window");
        if(android.view.Choreographer.getInstance()==null)throw new AssertionError("Original background Choreographer could not initialize");
        HostApplication.prepare(guest);Context context=HostApplication.applicationContext();Application app=new Application();HostApplication.attach(app,context);HostApplication.create(app);
        try{
            var accountOwner=HostAccounts.class.getDeclaredField("current");accountOwner.setAccessible(true);
            if(accountOwner.get(null)!=null)throw new AssertionError("Account storage started before a service request");
            AccountManager manager=context.getSystemService(AccountManager.class);
            if(manager==null||manager.getClass()!=AccountManager.class)throw new AssertionError("Original AccountManager client missing");
            if(manager.getAuthenticatorTypes().length!=0||manager.getAccounts().length!=0)throw new AssertionError("An account or authenticator was invented");
            for(var directory:new java.io.File[]{Environment.getDataSystemDeDirectory(0),Environment.getDataSystemCeDirectory(0)}){
                Path owned=HostFilesystem.file(directory).toPath().toRealPath();
                if(!owned.startsWith(data))throw new AssertionError("Account storage escaped the private application root");
            }
            System.out.println("PASS original AccountManager service, empty real account inventory and private storage");
        }finally{HostApplication.shutdown();HostWindowManager.shutdown();android.view.Choreographer.releaseInstance();HostDisplay.hostShutdown();HostDisplay.hostRemove();FrameworkResources.shutdown();HostLooper.close(loop);HostContext.hostShutdown();com.android.internal.os.BackgroundThread.get().quitSafely();com.android.internal.os.BackgroundThread.get().join();}
    }
}
