import java.nio.file.Path;
import java.util.List;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;

public final class PackageAbiProbe {
 public static void main(String[] args)throws Exception {
  var loop=RuntimeFixture.initialize(args[0],args[1]);
  Path runtime=Path.of(args[0]),data=Path.of(args[1]),apk=Path.of(args[2]);
  String name="org.maclauncher.metadata.fixture";
  try{
   HostContext.hostPackage(name,"1",1);
   HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.resolve("lib/arm").toString(),28);
   HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
   HostContext.hostApplicationNativeAbi("armeabi-v7a");
   FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));HostPackages.inspectSources(List.of(apk));
   var state=HostPackages.hostGetPackageStateInternal(null,name);
   var parsed=((com.android.internal.pm.parsing.pkg.AndroidPackageHidden)state.getPkg()).toAppInfoWithoutState();
   var binder=HostPackages.service().getApplicationInfo(name,0,android.os.UserHandle.myUserId());
   for(String abi:List.of(state.getPrimaryCpuAbi(),parsed.primaryCpuAbi,binder.primaryCpuAbi,HostContext.hostApplicationInfoSnapshot().primaryCpuAbi))
    if(!"armeabi-v7a".equals(abi))throw new AssertionError("Original package owner lost prepared ABI: "+abi);
   System.out.println("PASS original package state and Binder retain prepared ARM32 ABI");
  }finally{HostPackages.hostClearProviders();HostLooper.close(loop);FrameworkResources.shutdown();}
  System.exit(0);
 }
}
