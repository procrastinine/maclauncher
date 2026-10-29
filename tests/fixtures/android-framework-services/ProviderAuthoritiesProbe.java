package maclauncher.android;
import android.content.pm.*;import android.os.*;import java.nio.file.*;import java.util.*;
import maclauncher.android.fixture.*;import maclauncher.android.framework.*;
/** Original manifest parsing retains resource authorities and declaration order. */
public final class ProviderAuthoritiesProbe {
 static void check(boolean value){if(!value)throw new AssertionError();}
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]).toRealPath(),data=Path.of(args[1]).toRealPath(),apk=data.resolve("providers.apk");
  Looper loop=RuntimeFixture.initialize(args[0],args[1]);PackageManifest.add(apk,"providers");
  HostContext.hostPackage("owned.providers","1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
  FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));HostPackages.inspectSources(List.of(apk));
  try{
   var pm=HostPackages.service();int user=UserHandle.myUserId();
   check(pm.resolveContentProvider("same",0,user).name.equals("owned.providers.First"));
   check(pm.resolveContentProvider("second",0,user).name.equals("owned.providers.Second"));
   check(pm.resolveContentProvider("absent",0,user)==null);
   var resources=android.content.res.Resources.getSystem();
   int resourceId=resources.getIdentifier("config_wallpaperManagerServiceName","string","android");
   check(resourceId!=0);String resource=resources.getString(resourceId);
   check(pm.resolveContentProvider(resource,0,user).name.equals("owned.providers.Resource"));
   check(pm.getPackageInfo("owned.providers",PackageManager.GET_PROVIDERS,user).providers.length==4);
   System.out.println("PASS provider resources and manifest-order authority ownership");
  }finally{HostPackages.hostClearProviders();FrameworkResources.shutdown();HostContext.hostShutdown();HostLooper.close(loop);}
 }
}
