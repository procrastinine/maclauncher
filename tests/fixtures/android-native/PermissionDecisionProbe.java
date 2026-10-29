package maclauncher.android.framework;
import android.content.*;
import android.content.pm.*;
import android.os.*;
import android.permission.*;
import java.nio.file.*;
import java.util.*;

/** Original permission clients and the shared installation decision owner. */
public final class PermissionDecisionProbe {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]),data=Path.of(args[1]),apk=data.resolve("permissions.apk");
  Files.createDirectories(data.resolve("files"));Files.createDirectories(data.resolve("cache"));
  maclauncher.android.fixture.PackageManifest.add(apk,"permissions");
  var bootstrap=Class.forName("maclauncher.android.RuntimeBootstrap").getDeclaredMethod("initialize",Path.class,Path.class,Path.class,Path.class,String.class,boolean.class,boolean.class,boolean.class);
  bootstrap.setAccessible(true);bootstrap.invoke(null,runtime,data,data.resolve("files"),data.resolve("cache"),"org.example.permissions",false,false,false);
  FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
  HostContext.hostPackage("org.example.permissions","1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),35);
  HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);Looper loop=HostLooper.main();HostPackages.inspectSources(List.of(apk));
  HostStorageService.install();HostApplication.prepare(PermissionDecisionProbe.class.getClassLoader());
  Context context=HostApplication.applicationContext();HostApplication.attach(new android.app.Application(),context);
  PackageManager packages=context.getPackageManager();PermissionManager permissions=context.getSystemService(PermissionManager.class);
  UserManager users=context.getSystemService(UserManager.class);int user=context.getUserId();
  IUserManager userService=IUserManager.Stub.asInterface(ServiceManager.getService(Context.USER_SERVICE));
  UserInfo identity=users.getUserInfo(user);
  check(identity.isFull()&&!identity.isProfile(),"private full-user identity retains original UserInfo classification");
  check("".equals(userService.getProfileType(user)),"a full user has an empty profile type");
  check(userService.getProfileType(user+1)==null,"an absent user's profile type is null");
  check(!users.isProfile(user)&&!users.hasBadge(user),"original user clients preserve the non-profile badge fast path");
  var icon=new android.graphics.drawable.ColorDrawable(0xff235879);
  check(packages.getUserBadgedIcon(icon,UserHandle.of(user))==icon,"original package icon loading retains the non-profile icon");
  String post=android.Manifest.permission.POST_NOTIFICATIONS,camera=android.Manifest.permission.CAMERA,location=android.Manifest.permission.ACCESS_FINE_LOCATION;
  check(!packages.shouldShowRequestPermissionRationale(post),"no decision before request");
  check(permissions.getPermissionRequestState(context.getPackageName(),post,0)==Context.PERMISSION_REQUEST_STATE_REQUESTABLE,"declared dangerous permission requestable");
  check(permissions.getPermissionRequestState(context.getPackageName(),android.Manifest.permission.INTERNET,0)==Context.PERMISSION_REQUEST_STATE_GRANTED,"original normal permission grant");
  check(permissions.getPermissionRequestState(context.getPackageName(),android.Manifest.permission.RECORD_AUDIO,0)==Context.PERMISSION_REQUEST_STATE_UNREQUESTABLE,"undeclared permission cannot grant");
  try(var nativeController=new HostPermissionController(context)){
   var nativeClient=android.os.IPermissionController.Stub.asInterface(HostServices.publishedManager().checkService("permission"));
   check(nativeClient!=null,"native permission controller is published by its existing owner");
   check(nativeClient.checkPermission(android.Manifest.permission.INTERNET,android.os.Process.myPid(),android.os.Process.myUid()),"native normal grant uses the same permission owner");
   check(!nativeClient.checkPermission(android.Manifest.permission.ACCESS_SURFACE_FLINGER,android.os.Process.myPid(),android.os.Process.myUid()),"native compositor permission is not granted to an app");
   var systemGrants=com.android.server.SystemConfig.getInstance().getSystemPermissions();
   int audio=1041;String usage=android.Manifest.permission.PACKAGE_USAGE_STATS;
   check(systemGrants.get(audio)!=null&&systemGrants.get(audio).contains(usage),"original platform declares the audioserver UID grant");
   check(nativeClient.checkPermission(usage,android.os.Process.myPid(),audio),"native audio UID receives its original exact usage grant");
   int unrelated=19999;while(systemGrants.get(unrelated)!=null||unrelated==android.os.Process.myUid())unrelated++;
   check(!nativeClient.checkPermission(usage,android.os.Process.myPid(),unrelated),"unrelated application UID has no system grant");
   check(!nativeClient.checkPermission(android.Manifest.permission.INSTALL_PACKAGES,android.os.Process.myPid(),audio),"audioserver is not a blanket privileged principal");
   System.err.println("PLATFORM_PERMISSION_REPEAT_BEGIN");
   for(int attempt=0;attempt<32;attempt++){
    check(nativeClient.checkPermission(usage,android.os.Process.myPid(),audio),"repeated platform checks retain original exact UID grant");
    check(!nativeClient.checkPermission(usage,android.os.Process.myPid(),unrelated),"repeated checks never broaden the platform grant");
    check(!nativeClient.checkPermission(android.Manifest.permission.INSTALL_PACKAGES,android.os.Process.myPid(),audio),"repeated platform checks retain unrelated permission denial");
   }
   System.err.println("PLATFORM_PERMISSION_REPEAT_END");
   check(nativeClient.isRuntimePermission(camera)&&!nativeClient.isRuntimePermission(android.Manifest.permission.INTERNET),"native protection queries retain original declarations");
   check(Arrays.asList(nativeClient.getPackagesForUid(android.os.Process.myUid())).contains(context.getPackageName()),"native UID lookup uses the same installed catalog");
   check(nativeClient.getPackageUid(context.getPackageName(),0)==android.os.Process.myUid()&&nativeClient.getPackageUid("missing.package",0)==-1,"native package UID and absence preserve the original contract");
   check(nativeClient.noteOp(android.app.AppOpsManager.OPSTR_CAMERA,android.os.Process.myUid(),context.getPackageName())==android.app.AppOpsManager.MODE_IGNORED,"native app operation retains explicit camera policy");
  }
  check(HostServices.publishedManager().checkService("permission")==null,"native permission publication follows owner retirement");
  audioPermissions(context);
  HostPermissions.recordResult(new String[]{post,camera,location},new int[]{-1,-1,-1});
  for(String permission:List.of(post,camera,location)){
   check(packages.shouldShowRequestPermissionRationale(permission),"denial rationale for "+permission);
   check((packages.getPermissionFlags(permission,context.getPackageName(),android.os.Process.myUserHandle())&PackageManager.FLAG_PERMISSION_USER_SET)!=0,"original flags expose decision");
   check(context.checkSelfPermission(permission)==PackageManager.PERMISSION_DENIED,"denial never fabricates grant");
  }
  IPermissionManager service=IPermissionManager.Stub.asInterface(ServiceManager.getService("permissionmgr"));
  var originalSplits=com.android.server.SystemConfig.getInstance().getSplitPermissions();
  check(!originalSplits.isEmpty(),"original platform split declarations loaded");
  var splits=permissions.getSplitPermissions();check(splits.size()==originalSplits.size(),"complete original split declarations exposed");
  for(int i=0;i<splits.size();i++){
   var actual=splits.get(i);var original=originalSplits.get(i);
   check(actual.getSplitPermission().equals(original.getSplitPermission())&&actual.getNewPermissions().equals(original.getNewPermissions())&&actual.getTargetSdk()==original.getTargetSdk(),"split permission policy unchanged");
  }
  check(!service.shouldShowRequestPermissionRationale("another.package",post,0,UserHandle.myUserId()),"separate installation decisions");
  check(!service.shouldShowRequestPermissionRationale(context.getPackageName(),post,1,UserHandle.myUserId()),"separate device decisions");
  check(service.getAllPermissionStates(context.getPackageName(),"default:0",UserHandle.myUserId()).containsKey(post),"complete requested permission state");
  // Flush Android's original preference writer and inspect its actual output.
  android.app.QueuedWork.waitToFinish();
  var prefs=context.createDeviceProtectedStorageContext().getSharedPreferences("maclauncher.platform.permission-decisions",Context.MODE_PRIVATE);
  check((prefs.getInt(post,0)&PackageManager.FLAG_PERMISSION_USER_SET)!=0,"persisted decision");
  check(Files.readString(context.createDeviceProtectedStorageContext().getSharedPreferencesPath("maclauncher.platform.permission-decisions").toPath()).contains(post),"decision on disk");
  android.app.QueuedWork.resetHandler();
  var loader=Class.forName("android.app.SharedPreferencesImpl").getDeclaredField("sLoadExecutor");loader.setAccessible(true);
  ((java.util.concurrent.ExecutorService)loader.get(null)).shutdown();
  HostApplication.shutdown();HostLooper.close(loop);FrameworkResources.shutdown();
  System.out.println("PASS original permission clients, shared denial flags/rationale, unchanged grants and private persistence");
  // Original native Binder workers follow the process lifetime, as in the
  // platform-service entry point. All fixture-owned resources retired above.
  System.exit(0);
 }
 private static void audioPermissions(Context context)throws Exception{
  var grants=new java.util.concurrent.ConcurrentHashMap<Byte,int[]>();
  var packages=new java.util.concurrent.atomic.AtomicReference<List<com.android.media.permission.UidPackageState>>();
  var controller=new com.android.media.permission.INativePermissionController.Stub(){
   @Override public void populatePackagesForUids(List<com.android.media.permission.UidPackageState> values){packages.set(List.copyOf(values));}
   @Override public void updatePackagesForUid(com.android.media.permission.UidPackageState value){throw new AssertionError("Unexpected package mutation");}
   @Override public void populatePermissionState(byte permission,int[] uids){grants.put(permission,uids.clone());}
  };
  var endpoint=new Binder();
  var policy=new android.media.IAudioPolicyService.Default(){
   @Override public IBinder asBinder(){return endpoint;}
   @Override public com.android.media.permission.INativePermissionController getPermissionController(){return controller;}
  };
  endpoint.attachInterface(policy,"android.media.IAudioPolicyService");
  try(var owner=new HostAudioPermissions(context)){
   var audio=android.media.IAudioService.Stub.asInterface(HostServices.publishedManager().checkService("audio"));
   check(audio!=null&&audio.getNativeInterface()!=null,"complete shared audio/native endpoints are published");
   HostServices.manager().addService("media.audio_policy",endpoint,false,0);
   audio.getNativeInterface().permissionUpdateBarrier();
   check(packages.get()!=null&&packages.get().stream().anyMatch(p->p.uid==UserHandle.getAppId(android.os.Process.myUid())&&p.packageNames.contains(context.getPackageName())),"original audio provider receives the canonical package/UID");
   check(grants.size()==com.android.media.permission.PermissionEnum.ENUM_SIZE,"original provider synchronizes its complete permission family before the barrier");
   check(Arrays.stream(grants.get(com.android.media.permission.PermissionEnum.RECORD_AUDIO)).noneMatch(uid->uid==android.os.Process.myUid()),"native audio provider preserves undeclared microphone denial");
   audio.permissionUpdateBarrier();
  }finally{HostServices.manager().tryUnregisterService("media.audio_policy",endpoint);}
  check(HostServices.publishedManager().checkService("audio")==null,"native audio publication retires with its system owner");
 }
}
