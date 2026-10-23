package maclauncher.android.framework;

import android.app.ActivityThread;
import android.content.pm.ApplicationInfo;
import com.android.internal.compat.IPlatformCompat;
import com.android.internal.pm.parsing.pkg.AndroidPackageHidden;
import com.android.internal.pm.parsing.pkg.ParsedPackage;

/** Original package compatibility runs before application or ActivityManager binding. */
public final class EarlyPackageCompatProbe {
    public static IPlatformCompat verify(int target) throws Exception {
        if(ActivityThread.currentActivityThread()!=null)throw new AssertionError("Application was bound before package policy");
        var previous=android.compat.Compatibility.getBehaviorChangeDelegate();
        ParsedPackage parsed=(ParsedPackage)com.android.internal.pm.parsing.pkg.PackageImpl.forTesting("owned.compat.pending");
        parsed.setUid(android.os.Process.myUid());
        ((com.android.internal.pm.pkg.parsing.ParsingPackage)parsed).setTargetSdkVersion(target);
        HostSharedLibraries.prepare(parsed,false);
        var service=IPlatformCompat.Stub.asInterface(HostServices.manager().checkService("platform_compat"));
        if(service==null||service.getClass()!=com.android.server.compat.PlatformCompat.class)
            throw new AssertionError("Original compatibility service must precede package policy");
        long change=((com.android.server.compat.PlatformCompat)service).lookupChangeId("REMOVE_ANDROID_TEST_BASE");
        if(change<0)throw new AssertionError("Generated test-library compatibility definition missing");
        ApplicationInfo app=((AndroidPackageHidden)parsed).toAppInfoWithoutState();
        boolean enabled=service.isChangeEnabled(change,app);
        if(parsed.getUsesLibraries().contains("android.test.base")==enabled)
            throw new AssertionError("Original library updater differs from generated compatibility policy");
        if(ActivityThread.currentActivityThread()!=null||android.compat.Compatibility.getBehaviorChangeDelegate()!=previous)
            throw new AssertionError("Package preparation must not bind an application or placeholder SDK callback");
        return service;
    }
}
