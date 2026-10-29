import android.content.pm.*;
import android.os.*;
import com.android.server.pm.PackageSetting;
import com.android.server.pm.pkg.*;
import java.nio.file.*;
import java.util.List;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;

/** Original PackageManagerInternal call sites, rewritten by ServicePortability,
 * read the same PackageSetting records that IPackageManager clients receive. */
public final class PackageStateProbe {
    static final class Queries {
        static PackageStateInternal state(PackageManagerInternal owner,String name){return owner.getPackageStateInternal(name);}
        static android.util.ArrayMap<String,? extends PackageStateInternal> states(PackageManagerInternal owner){return owner.getPackageStates();}
        static AndroidPackage parsed(PackageManagerInternal owner,String name){return owner.getAndroidPackage(name);}
        static AndroidPackage legacyParsed(PackageManagerInternal owner,String name){return owner.getPackage(name);}
        static boolean launched(PackageManagerInternal owner,String name,int user){return owner.wasPackageEverLaunched(name,user);}
        static boolean stopped(PackageManagerInternal owner,String name,int user)throws Exception{return owner.isPackageStopped(name,user);}
    }
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception {
        var loop=RuntimeFixture.initialize(args[0],args[1]);Path runtime=Path.of(args[0]),data=Path.of(args[1]),apk=Path.of(args[2]);
        String name="org.maclauncher.metadata.fixture";int user=UserHandle.myUserId();
        HostContext.hostPackage(name,"1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);
        HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));HostPackages.inspectSources(List.of(apk));
        try {
            var state=Queries.state(null,name);check(state instanceof PackageSetting,"original package state owner");
            check(Queries.states(null).get(name)==state,"snapshot retains the same original state");
            check(Queries.parsed(null,name)==state.getPkg()&&Queries.legacyParsed(null,name)==state.getPkg(),"both parsed-package interfaces share the original package");
            check(UserHandle.getAppId(HostPackages.service().getPackageUid(name,0L,user))==state.getAppId(),"Binder UID and internal app ID share one record");
            var snapshot=Queries.states(null);snapshot.clear();check(Queries.state(null,name)==state,"index snapshot cannot erase the installed catalog");
            check(!Queries.stopped(null,name,user)&&Queries.launched(null,name,user),"inspected installation starts launched and running");
            var mutable=((PackageSetting)state).getOrCreateUserState(user);mutable.setStopped(true).setNotLaunched(true);
            check(Queries.stopped(null,name,user)&&!Queries.launched(null,name,user),"policy readers see original user-state updates");
            check((HostPackages.service().getApplicationInfo(name,0,user).flags&ApplicationInfo.FLAG_STOPPED)!=0,"Binder package metadata sees the same stopped state");
            mutable.setStopped(false).setNotLaunched(false);
            check(!Queries.stopped(null,name,user)&&Queries.launched(null,name,user),"state changes do not leave a separate Internal cache");
            check((HostPackages.service().getApplicationInfo(name,0,user).flags&ApplicationInfo.FLAG_STOPPED)==0,"Binder package metadata follows the restored state");
            check(Queries.state(null,"missing.package")==null&&Queries.parsed(null,"missing.package")==null,"original absent-package result");
            try{Queries.launched(null,"missing.package",user);throw new AssertionError("unknown launch record accepted");}catch(IllegalArgumentException expected){}
            try{Queries.stopped(null,"missing.package",user);throw new AssertionError("unknown stopped record accepted");}catch(PackageManager.NameNotFoundException expected){}
            try{Queries.stopped(null,name,user+1);throw new AssertionError("cross-user read accepted");}catch(SecurityException expected){}
            System.out.println("PASS original package records shared by Internal policy and Binder clients");
        }finally{HostPackages.hostClearProviders();HostLooper.close(loop);FrameworkResources.shutdown();}
        System.exit(0);
    }
}
