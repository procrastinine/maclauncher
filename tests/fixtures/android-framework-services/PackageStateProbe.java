import android.content.pm.*;
import android.os.*;
import com.android.server.pm.PackageSetting;
import com.android.server.pm.pkg.*;
import java.nio.file.*;
import java.util.List;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;

public final class PackageStateProbe {
    static final class Queries {
        static PackageStateInternal state(PackageManagerInternal owner,String name){return owner.getPackageStateInternal(name);}
        static android.util.ArrayMap<String,? extends PackageStateInternal> states(PackageManagerInternal owner){return owner.getPackageStates();}
        static AndroidPackage parsed(PackageManagerInternal owner,String name){return owner.getAndroidPackage(name);}
        static AndroidPackage legacyParsed(PackageManagerInternal owner,String name){return owner.getPackage(name);}
        static boolean launched(PackageManagerInternal owner,String name,int user){return owner.wasPackageEverLaunched(name,user);}
        static boolean stopped(PackageManagerInternal owner,String name,int user)throws Exception{return owner.isPackageStopped(name,user);}
        static com.android.server.pm.PackageManagerLocal.UnfilteredSnapshot snapshot(com.android.server.pm.PackageManagerLocal owner){return owner.withUnfilteredSnapshot();}
        static com.android.server.pm.PackageManagerLocal.FilteredSnapshot filtered(com.android.server.pm.PackageManagerLocal owner,int caller,UserHandle user){return owner.withFilteredSnapshot(caller,user);}
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
            var snapshot=Queries.states(null);snapshot.clear();check(Queries.state(null,name)==state,"index snapshot cannot erase the installed catalog");
            var mutable=((PackageSetting)state).getOrCreateUserState(user);mutable.setStopped(true).setNotLaunched(true);
            var local=Queries.snapshot(null);var child=local.filtered(android.os.Process.myUid(),UserHandle.of(user));
            check(local.getPackageStates().get(name)!=state,"local reader owns an original immutable PackageSetting snapshot");
            check(child.getPackageState(name)==local.getPackageStates().get(name),"filtered view shares its parent snapshot");
            try{local.getPackageStates().clear();throw new AssertionError("mutable local snapshot");}catch(UnsupportedOperationException expected){}
            check(Queries.stopped(null,name,user)&&!Queries.launched(null,name,user),"policy readers see original user-state updates");
            check((HostPackages.service().getApplicationInfo(name,0,user).flags&ApplicationInfo.FLAG_STOPPED)!=0,"Binder package metadata sees the same stopped state");
            mutable.setStopped(false).setNotLaunched(false);
            check(local.getPackageStates().get(name).getUserStateOrDefault(user).isStopped(),"live mutations do not change a retained snapshot");
            try(var next=Queries.filtered(null,android.os.Process.myUid(),UserHandle.of(user))){check(!next.getPackageState(name).getUserStateOrDefault(user).isStopped(),"new snapshots observe committed state");}
            try(var other=Queries.filtered(null,android.os.Process.myUid(),UserHandle.of(user+1))){check(other.getPackageStates().isEmpty(),"profile snapshot preserves user isolation");}
            local.close();
            try{child.getPackageStates();throw new AssertionError("child survived parent close");}catch(IllegalStateException expected){}
            child.close();
            check(!Queries.stopped(null,name,user)&&Queries.launched(null,name,user),"state changes do not leave a separate Internal cache");
            check(Queries.state(null,"missing.package")==null&&Queries.parsed(null,"missing.package")==null,"original absent-package result");
            try{Queries.launched(null,"missing.package",user);throw new AssertionError("unknown launch record accepted");}catch(IllegalArgumentException expected){}
            try{Queries.stopped(null,"missing.package",user);throw new AssertionError("unknown stopped record accepted");}catch(PackageManager.NameNotFoundException expected){}
            try{Queries.stopped(null,name,user+1);throw new AssertionError("cross-user read accepted");}catch(SecurityException expected){}
            System.out.println("PASS original package records shared by Internal policy and Binder clients");
        }finally{HostPackages.hostClearProviders();HostLooper.close(loop);FrameworkResources.shutdown();}
        System.exit(0);
    }
}
