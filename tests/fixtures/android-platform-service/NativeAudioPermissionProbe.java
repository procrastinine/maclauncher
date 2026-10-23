package maclauncher.android.framework;
import java.nio.file.*;import java.util.*;import android.os.*;import android.media.*;import com.android.media.permission.*;
public class NativeAudioPermissionProbe{
 public static void main(String[]args){try{run(args);System.exit(0);}catch(Throwable error){error.printStackTrace();System.exit(1);}}
 static void run(String[]args)throws Exception{
  Path runtime=Path.of(args[0]),data=Path.of(args[1]);Files.createDirectories(data.resolve("files"));Files.createDirectories(data.resolve("cache"));
  var bootstrap=Class.forName("maclauncher.android.RuntimeBootstrap").getDeclaredMethod("initialize",Path.class,Path.class,Path.class,Path.class,String.class,boolean.class,boolean.class,boolean.class);bootstrap.setAccessible(true);bootstrap.invoke(null,runtime,data,data.resolve("files"),data.resolve("cache"),"android",false,false,false);
  HostProcessIdentity.configure(1000,(int)new com.sun.security.auth.module.UnixSystem().getUid());HostLooper.main();
  try(var system=HostSystemServices.start(runtime,data,"android.system")){
   for(var e:HostPackages.hostGetPackageStates(null).entrySet())System.out.println("PACKAGE "+e.getKey()+"="+e.getValue().getAppId());
   var grants=new HashMap<Byte,int[]>();var packages=new java.util.concurrent.atomic.AtomicReference<List<UidPackageState>>();
   var controller=new INativePermissionController.Stub(){public void populatePackagesForUids(List<UidPackageState> values){packages.set(List.copyOf(values));}public void updatePackagesForUid(UidPackageState value){}public void populatePermissionState(byte p,int[]uids){grants.put(p,uids.clone());System.out.println("PERMISSION "+p+"="+Arrays.toString(uids));}};
   var binder=new Binder();var policy=new IAudioPolicyService.Default(){public IBinder asBinder(){return binder;}public INativePermissionController getPermissionController(){return controller;}};binder.attachInterface(policy,IAudioPolicyService.DESCRIPTOR);
   HostServices.manager().addService("media.audio_policy",binder,false,0);
   var audio=IAudioService.Stub.asInterface(HostServices.manager().checkService("audio"));audio.getNativeInterface().permissionUpdateBarrier();
   if(packages.get()==null||grants.size()!=PermissionEnum.ENUM_SIZE)throw new AssertionError("Incomplete native publication "+grants.size());
   for(byte i=0;i<PermissionEnum.ENUM_SIZE;i++)if(Arrays.stream(grants.get(i)).noneMatch(v->v==1000))throw new AssertionError("Missing system principal for "+i);
   System.out.println("PASS original system package/UID and all native permission vectors");
  }
 }
}
