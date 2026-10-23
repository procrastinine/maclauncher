import android.content.*;
import android.content.pm.*;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.*;
import maclauncher.android.framework.*;
import maclauncher.android.fixture.RuntimeFixture;
/** Inspected APK metadata and original package parser/resolver, without loading application code. */
public final class PackageIntentProbe {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]).toRealPath(),data=Path.of(args[1]).toRealPath();Looper loop=RuntimeFixture.initialize(args[0],args[1]);
  LaunchConfig config=LaunchConfig.read(Path.of(args[2]));String own=config.text("packageName");
  HostContext.hostPackage(own,config.text("versionName"),(int)config.number("versionCode"));HostContext.hostApplicationInfo(0,config.file("sourceApk").toString(),data.toString(),data.toString(),0);HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
  FrameworkResources.configure(runtime.resolve("android-framework.jar"),config.sourceApks());HostPackages.inspectSources(config.sourceApks());HostStorageService.install();HostApplication.prepare(PackageIntentProbe.class.getClassLoader());Context context=HostApplication.applicationContext();var application=new android.app.Application();HostApplication.attach(application,context);
  try{
   PackageManager manager=context.getPackageManager();check(manager.getClass().getName().equals("android.app.ApplicationPackageManager"),"original package client");
   PackageInfo full=manager.getPackageInfo(own,PackageManager.GET_PERMISSIONS|PackageManager.GET_ACTIVITIES|PackageManager.GET_RECEIVERS|PackageManager.GET_SERVICES|PackageManager.GET_PROVIDERS|PackageManager.GET_META_DATA);
   check(full.applicationInfo.dataDir.equals(data.toString()),"parsed metadata retains private data owner");
   check(full.requestedPermissions!=null&&full.requestedPermissions.length>0,"original requested permissions exposed");
   int normalGrants=0;for(String permission:full.requestedPermissions){PermissionInfo definition;try{definition=manager.getPermissionInfo(permission,0);}catch(PackageManager.NameNotFoundException absentPermission){continue;}if((definition.protectionLevel&PermissionInfo.PROTECTION_MASK_BASE)==PermissionInfo.PROTECTION_NORMAL){normalGrants++;check(context.checkSelfPermission(permission)==PackageManager.PERMISSION_GRANTED,"normal requested permission: "+permission);}}
   check(normalGrants>0,"actual platform normal permission definitions were checked");
   check(context.checkSelfPermission("android.permission.ACCESS_FINE_LOCATION")==PackageManager.PERMISSION_DENIED,"no unsolicited location grant");
   check(context.checkSelfPermission("android.permission.CAMERA")==PackageManager.PERMISSION_DENIED,"no unsolicited camera grant");
   check(full.services!=null&&full.services.length>0,"complete declared service family");
   check(Arrays.equals(full.splitNames==null?new String[0]:full.splitNames,full.applicationInfo.splitNames==null?new String[0]:full.applicationInfo.splitNames),"original split names remain paired with source order");
   Intent absent=new Intent("com.android.vending.billing.InAppBillingService.BIND").setPackage("com.android.vending");
   check(manager.queryIntentServices(absent,PackageManager.ResolveInfoFlags.of(0)).isEmpty()&&manager.resolveService(absent,0)==null,"uninstalled optional billing service");
   check(manager.queryIntentServices(new Intent("owned.intent.ABSENT").setPackage(own),0).isEmpty(),"original full manifest parser and indexed absence");
   Intent launcher=new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(own);
   List<ResolveInfo> launches=manager.queryIntentActivities(launcher,PackageManager.GET_RESOLVED_FILTER);
   check(!launches.isEmpty(),"original launcher filter resolves");
   for(var result:launches)check(result.filter!=null&&result.filter.hasAction(Intent.ACTION_MAIN),"original resolved filter");
   for(var service:full.services){Intent explicit=new Intent().setComponent(new ComponentName(own,service.name));check(manager.resolveService(explicit,0).serviceInfo.name.equals(service.name),"explicit service resolution");}
   check(manager.queryIntentContentProviders(new Intent("fixture.ABSENT_PROVIDER"),0).isEmpty(),"absent provider filter is an ordinary empty resolution");
   if(full.providers!=null)for(var provider:full.providers){
    Intent explicit=new Intent().setComponent(new ComponentName(own,provider.name));
    var matches=manager.queryIntentContentProviders(explicit,PackageManager.ResolveInfoFlags.of(PackageManager.GET_META_DATA));
    check(matches.size()==1&&matches.getFirst().providerInfo.name.equals(provider.name),"provider shares the original component resolver");
   }
   check(manager.queryIntentActivities(new Intent(launcher).addCategory("owned.intent.ABSENT"),0).isEmpty(),"upstream category matching");
   try(var children=Files.list(data.resolve("cache"))){check(children.noneMatch(path->path.getFileName().toString().startsWith("package-manifest-")),"temporary split links retired");}
   System.out.println("PASS original package parser and resolver with original APKs, optional billing absence, manifest metadata, permissions and category matching");
  }finally{HostApplication.shutdown();HostPackages.hostClearProviders();HostLooper.close(loop);FrameworkResources.shutdown();HostContext.hostShutdown();}
 }
}
