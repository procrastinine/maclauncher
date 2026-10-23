package maclauncher.android;

import android.app.Application;
import android.content.Context;
import android.provider.Settings;
import java.nio.file.*;
import java.util.List;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;

/** Exercises the complete Settings client before any lazy profile connection. */
public final class BootMetadataProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        int status=0;var loop=RuntimeFixture.initialize(args[0],args[1]);
        try(var authority=ProcessAuthority.read(5,"org.example.window","org.example.window")){
            HostProcessIdentity.configure(authority.self.uid(),authority.self.hostUid());
            Path runtime=Path.of(args[0]),data=Path.of(args[1]),apk=data.resolve("owned.apk");
            System.load(System.getProperty("klepton.graphics"));
            SyntheticResources.apk(apk,"","Window",null);maclauncher.android.fixture.PackageManifest.add(apk,"window");
            FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
            HostContext.hostPackage("org.example.window","1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);
            HostContext.hostApplicationIdentity(authority.self.uid(),0);HostContext.hostClassLoader(BootMetadataProbe.class.getClassLoader());
            HostPackages.inspectSources(List.of(apk));HostDisplay.hostPublish(1,320,240,60);HostDisplayEvents.hostSetWakeup(()->{});
            HostApplication.prepare(BootMetadataProbe.class.getClassLoader());Context context=HostApplication.applicationContext();
            var app=new Application();HostApplication.attach(app,context);HostApplication.create(app);
            var resolver=context.getContentResolver();int expected=Integer.parseInt(args[2]);
            check(Settings.Global.getInt(resolver,Settings.Global.BOOT_COUNT)==expected,"First original Settings query lost initial boot metadata");
            String identity=Settings.Secure.getString(resolver,Settings.Secure.ANDROID_ID);
            check(identity!=null&&identity.equals(Files.readString(data.resolve("system/android-id"))),"Application identity did not retain its private owner");
            authority.attachPlatform();
            check(Settings.Global.getInt(resolver,Settings.Global.BOOT_COUNT)==expected,"Later provider state changed the initialized boot counter");
            System.out.println("PASS original Settings sees initial boot metadata before lazy profile attachment and preserves private application identity");
        }catch(Throwable failure){failure.printStackTrace();status=1;}
        finally{HostApplication.shutdown();FrameworkResources.shutdown();HostRemoteServices.shutdown();HostLooper.close(loop);}
        System.exit(status);
    }
}
