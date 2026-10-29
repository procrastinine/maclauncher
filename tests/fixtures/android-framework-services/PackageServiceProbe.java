import android.content.*;import android.content.pm.*;import android.content.res.*;import android.os.*;
import maclauncher.android.framework.*;import java.nio.file.*;import java.util.*;import java.util.zip.*;

/** Exercises the unchanged ApplicationPackageManager against inspected local data. */
public final class PackageServiceProbe {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 // A bounded drain posts a boundary; work queued during it at the same uptime runs
 // in a later drain, as on a running Looper. Settle until the queue stays idle.
 static void settle(Looper loop){long end=System.nanoTime()+2_000_000_000L;for(int quiet=0;quiet<3&&System.nanoTime()<end;){HostLooper.drain(loop);if(loop.getQueue().isIdle()){quiet++;try{Thread.sleep(2);}catch(InterruptedException e){Thread.currentThread().interrupt();return;}}else quiet=0;}}
 public static void main(String[]args)throws Exception{
  Path runtime=Path.of(args[0]).toRealPath(),data=Path.of(args[1]).toRealPath(),apk=data.resolve("owned.apk");String own="owned.packages";
  try(var zip=new ZipOutputStream(Files.newOutputStream(apk))){zip.putNextEntry(new ZipEntry("assets/value"));zip.write(1);zip.closeEntry();}
  maclauncher.android.fixture.PackageManifest.add(apk,"package");
  HostFilesystem.configure(runtime,data,data,data,own);
  System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
  System.setProperty("klepton.bridge",runtime.resolve("native/libklepton-jvm.dylib").toString());
  System.setProperty("klepton.audio",runtime.resolve("native/libklepton-audio.dylib").toString());
  System.load(System.getProperty("klepton.bridge"));System.load(runtime.resolve("native/libnativebinding.dylib").toString());maclauncher.android.framework.HostProcessIdentity.initializeIds();if(args.length>2)System.load(args[2]);
  JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
  FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
  HostContext.hostPackage(own,"1.2",12);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),35);HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
  Bundle appMeta=new Bundle();appMeta.putString("application","value");HostContext.hostApplicationMetaData(appMeta);HostPackages.hostInstallTimes(data,apk);
  maclauncher.android.framework.HostLooper.main();HostPackages.inspectSources(List.of(apk));
  Looper loop=HostLooper.main();HostStorageService.install();HostApplication.prepare(PackageServiceProbe.class.getClassLoader());
  Context context=HostApplication.applicationContext();var application=new android.app.Application();HostApplication.attach(application,context);
  ProviderInfo provider=new ProviderInfo();provider.packageName=own;provider.name=own+".Provider";provider.authority=own+".provider";provider.enabled=false;provider.applicationInfo=context.getApplicationInfo();provider.metaData=new Bundle();provider.metaData.putString("provider","real");
  ServiceInfo service=new ServiceInfo();service.packageName=own;service.name=own+".Service";service.applicationInfo=context.getApplicationInfo();service.enabled=true;

  PackageManager pm=context.getPackageManager();check(pm.getClass().getName().equals("android.app.ApplicationPackageManager"),"complete upstream client");
  long beforeUse=System.currentTimeMillis();HostPackages.service().notifyPackageUse(own,PackageManager.NOTIFY_PACKAGE_USE_CROSS_PACKAGE);
  var currentField=HostPackages.class.getDeclaredField("current");currentField.setAccessible(true);Object installation=currentField.get(null);var stateField=installation.getClass().getDeclaredField("packageState");stateField.setAccessible(true);
  var packageState=(com.android.server.pm.PackageSetting)stateField.get(installation);long use=packageState.getLastPackageUsageTime()[PackageManager.NOTIFY_PACKAGE_USE_CROSS_PACKAGE];check(use>=beforeUse&&use<=System.currentTimeMillis(),"package use retained by original PackageSetting");
  HostPackages.service().notifyPackageUse(own,-1);HostPackages.service().notifyPackageUse(own,PackageManager.NOTIFY_PACKAGE_USE_REASONS_COUNT);HostPackages.service().notifyPackageUse("absent.package",0);check(packageState.getLastPackageUsageTime()[PackageManager.NOTIFY_PACKAGE_USE_CROSS_PACKAGE]==use,"original invalid-reason and absent-package semantics");
  check(pm.getProperty("owned.application.property",own).getString().equals("manifest"),"original modern application property");
  check(pm.getProperty("owned.service.property",new ComponentName(own,service.name)).getInteger()==7,"original modern service property");
  check(pm.queryApplicationProperty("owned.application.property").size()==1&&pm.queryApplicationProperty("owned.absent").isEmpty(),"original property index and absence");
  Intent optional=new Intent("com.android.vending.billing.InAppBillingService.BIND").setPackage("com.android.vending");check(pm.queryIntentServices(optional,PackageManager.ResolveInfoFlags.of(0)).isEmpty()&&pm.resolveService(optional,0)==null,"absent optional service is a normal empty resolution");
  Intent explicit=new Intent().setComponent(new ComponentName(own,service.name));check(pm.resolveService(explicit,0).serviceInfo.name.equals(service.name)&&pm.queryIntentServices(explicit,0).size()==1,"explicit service resolution through original client");
  check(pm.resolveService(new Intent().setComponent(new ComponentName(own,"Missing")),0)==null,"unknown local service absent");
  ComponentName key=new ComponentName(own,provider.name);
  ProviderInfo found=pm.getProviderInfo(key,640);check(!found.enabled&&found.metaData.getString("provider").equals("real"),"metadata and disabled flags640");
  check(pm.getProviderInfo(key,PackageManager.ComponentInfoFlags.of(640)).name.equals(provider.name),"raw typed flag overload");
  try{pm.getProviderInfo(key,128);throw new AssertionError("disabled provider visible");}catch(PackageManager.NameNotFoundException expected){}
  check(pm.getProviderInfo(key,512).metaData==null,"metadata opt-in");
  check(pm.resolveContentProvider(provider.authority,640)!=null&&pm.resolveContentProvider(provider.authority,PackageManager.ComponentInfoFlags.of(640))!=null,"authority lookup through raw typed and integer overloads");
  check(pm.getApplicationInfo(own,128).uid==android.os.Process.myUid(),"actual UID");
  // AOSP may return separate Resources wrappers for package and Context lookups.
  // Both must resolve the installed APK through the original resource manager.
  Resources packageResources=pm.getResourcesForApplication(own);
  try(var a=packageResources.getAssets().open("value");var b=context.getAssets().open("value")){check(a.read()==1&&b.read()==1,"package and Context resources read the installed APK");}
  check(packageResources.getDisplayMetrics().densityDpi==context.getResources().getDisplayMetrics().densityDpi,"package and Context resources use the actual display density");
  try{pm.getApplicationInfo("unavailable.package",0);throw new AssertionError("invented package");}catch(PackageManager.NameNotFoundException expected){}
  PackageInfo info=pm.getPackageInfo(own,PackageManager.GET_PROVIDERS|PackageManager.GET_SERVICES|PackageManager.MATCH_DISABLED_COMPONENTS|PackageManager.GET_META_DATA);
  check(info.versionCode==12&&info.providers.length==1&&info.services.length==1&&info.firstInstallTime>0,"raw package generation and arrays");
  check(pm.getInstalledPackages(0).size()==1&&!pm.isInstantApp(),"local installation inventory");
  check(!pm.hasSystemFeature("unavailable.hardware")&&pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN),"advertised features only");
  UserManager users=context.getSystemService(UserManager.class);check(users.isUserUnlocked()&&users.isUserUnlockingOrUnlocked(UserHandle.myUserId()),"real private storage unlocked");check(!users.isUserUnlocked(UserHandle.of(99)),"unavailable user absent");
  android.app.NotificationManager notifications=context.getSystemService(android.app.NotificationManager.class);check(!notifications.areNotificationsEnabled(),"notification delivery remains disabled");
  android.app.NotificationChannel channel=new android.app.NotificationChannel("owned","Owned",3);channel.setGroup("category");channel.enableVibration(true);channel.setVibrationPattern(new long[]{0,10,20});notifications.createNotificationChannel(channel);
  var stored=notifications.getNotificationChannel("owned");check("category".equals(stored.getGroup())&&Arrays.equals(stored.getVibrationPattern(),new long[]{0,10,20}),"complete upstream channel state persisted");
  notifications.deleteNotificationChannel("owned");check(notifications.getNotificationChannel("owned")==null,"channel retirement");
  ClipboardManager clipboard=context.getSystemService(ClipboardManager.class);int[] changed={0};ClipboardManager.OnPrimaryClipChangedListener listener=()->changed[0]++;clipboard.addPrimaryClipChangedListener(listener);clipboard.setPrimaryClip(ClipData.newPlainText("owned","value"));settle(loop);check(changed[0]==1&&clipboard.getPrimaryClip().getItemAt(0).getText().toString().equals("value"),"raw clipboard client and callback");clipboard.removePrimaryClipChangedListener(listener);clipboard.clearPrimaryClip();settle(loop);check(changed[0]==1&&!clipboard.hasPrimaryClip(),"clipboard removal and clear");
  String peerApk=System.getenv("ANDROID_SERVICE_APK");if(peerApk!=null){
   int packageFlags=PackageManager.GET_SIGNING_CERTIFICATES|PackageManager.GET_SERVICES|PackageManager.MATCH_DISABLED_COMPONENTS;
   Path source=Path.of(peerApk).toRealPath();PackageInfo original=pm.getPackageArchiveInfo(source.toString(),packageFlags);
   check(original!=null&&original.signingInfo!=null,"actual signed service APK");
   int peerUid=10001;Path peerData=data.resolve("not-readable-peer-data");
   var record=new org.json.JSONObject().put("packageName",original.packageName).put("sourceApks",new org.json.JSONArray().put(source.toString())).put("nativeRoot",data.toString()).put("dataRoot",peerData.toString()).put("uid",peerUid).put("firstInstallTime",11).put("lastUpdateTime",17);
   HostPackages.inspectInstalled(new org.json.JSONArray().put(record).toString());
   PackageInfo peer=pm.getPackageInfo(original.packageName,packageFlags);
   check(peer.getLongVersionCode()==original.getLongVersionCode()&&peer.applicationInfo.uid==peerUid,"real version and distinct package UID");
   check(Arrays.equals(peer.signingInfo.getApkContentsSigners(),original.signingInfo.getApkContentsSigners()),"actual certificates preserved without replacement");
   check(peer.applicationInfo.dataDir.equals(peerData.toString())&&!Files.exists(peerData),"peer data metadata grants no data access or creation");
   check(peer.services.length==original.services.length&&pm.getInstalledPackages(0).size()==2,"all original service declarations remain available");
   for(ServiceInfo item:peer.services){var resolved=pm.resolveService(new Intent().setComponent(new ComponentName(item.packageName,item.name)),PackageManager.MATCH_DISABLED_COMPONENTS);check(resolved!=null&&Objects.equals(resolved.serviceInfo.processName,item.processName),"original explicit process resolution");}
   check(pm.checkSignatures(original.packageName,original.packageName)==PackageManager.SIGNATURE_MATCH,"upstream signing comparison");
   check(pm.getPackagesForUid(peerUid).length==1&&pm.getPackageUid(original.packageName,0)==peerUid,"package-to-UID lookup is distinct");
  }
  HostApplication.shutdown();HostLooper.close(loop);HostPackages.hostClearProviders();FrameworkResources.shutdown();
  System.out.println("PASS full AOSP package client, component matching, disabled metadata, typed flags, resources, local installation, user, channel storage and private clipboard");
 }
}
