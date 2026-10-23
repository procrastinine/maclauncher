package maclauncher.android.framework;

import android.content.Context;
import android.content.pm.*;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import maclauncher.android.fixture.RuntimeFixture;
import org.json.*;

/** Package metadata and permission queries share original signer verification. */
public final class PackagePermissionFlagsProbe {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]),data=Path.of(args[1]),client=Path.of(args[2]),server=Path.of(args[3]);String mode=args[4];
  var loop=RuntimeFixture.initialize(args[0],args[1]);
  HostContext.hostPackage("fixture.client","1",1);HostContext.hostApplicationInfo(false,client.toString(),data.toString(),data.toString(),28);
  HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(client));HostPackages.inspectSources(List.of(client),false);
  HostPackages.inspectInstalled(new JSONArray().put(new JSONObject().put("packageName","fixture.server").put("uid",11032).put("sourceApks",new JSONArray().put(server.toString())).put("dataRoot",data.resolve("server").toString()).put("nativeRoot",data.resolve("lib").toString()).put("firstInstallTime",1).put("lastUpdateTime",1)).toString());
  try{
   var packages=HostPackages.service();int user=UserHandle.myUserId();
   PackageInfo metadata=packages.getPackageInfo("fixture.client",PackageManager.GET_META_DATA,user);
   check(metadata!=null&&metadata.requestedPermissions==null,"metadata query does not request permission state");
   if(!mode.equals("unsigned")){
    PackageInfo certificates=packages.getPackageInfo("fixture.client",PackageManager.GET_SIGNING_CERTIFICATES,user);
    check(certificates.signingInfo!=null,"certificate-only query retains original signing metadata");
   }
   if(mode.equals("lock"))permissionLock(packages,user);
   else if(mode.equals("unsigned")){
    var original=android.util.apk.ApkSignatureVerifier.verify(android.content.pm.parsing.result.ParseTypeImpl.forDefaultParsing(),client.toString(),android.util.apk.ApkSignatureVerifier.getMinimumSignatureSchemeVersionForTargetSdk(28));
    check(original.isError(),"original verifier rejects the unsigned fixture");
    boolean rejected=false;try{packages.getPackageInfo("fixture.client",PackageManager.GET_PERMISSIONS,user);}catch(Exception failure){for(Throwable cause=failure;cause!=null;cause=cause.getCause())if(cause instanceof java.io.IOException&&Objects.equals(cause.getMessage(),original.getErrorMessage()))rejected=true;}
    check(rejected,"permission grants still reject an unsigned signature-permission claimant");
   }else{
    PackageInfo permissions=packages.getPackageInfo("fixture.client",PackageManager.GET_PERMISSIONS,user);
    int index=Arrays.asList(permissions.requestedPermissions).indexOf("fixture.server.READ");check(index>=0,"requested permission retained");
    boolean granted=(permissions.requestedPermissionsFlags[index]&PackageInfo.REQUESTED_PERMISSION_GRANTED)!=0;
    check(granted==mode.equals("signed"),"signature permission follows verified publisher identity");
   }
   System.out.println("PASS package permission flags "+mode);
  }finally{HostPackages.hostClearProviders();HostLooper.close(loop);FrameworkResources.shutdown();}
  System.exit(0);
 }
 private static void permissionLock(IPackageManager packages,int user)throws Exception{
  var field=HostPackages.class.getDeclaredField("current");field.setAccessible(true);Object installation=field.get(null);
  var executor=Executors.newFixedThreadPool(2);Future<?> grants=null;
  try{
   synchronized(installation){
    var thread=new java.util.concurrent.atomic.AtomicReference<Thread>();var started=new CountDownLatch(1);
    grants=executor.submit(()->{thread.set(Thread.currentThread());started.countDown();try{packages.getPackageInfo("fixture.client",PackageManager.GET_PERMISSIONS,user);}catch(Exception failure){throw new CompletionException(failure);}});
    check(started.await(2,TimeUnit.SECONDS),"permission query started");
    long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(3);boolean verifying=false;
    while(System.nanoTime()<deadline){
     verifying=thread.get().getState()==Thread.State.BLOCKED&&Arrays.stream(thread.get().getStackTrace()).anyMatch(frame->frame.getMethodName().equals("verifiedSigningDetails"));
     if(verifying)break;Thread.sleep(2);
    }
    check(verifying,"original signer verification reached its installation owner");
    var local=executor.submit(()->HostPermissions.checkLocal("fixture.unrequested",android.os.Process.myUid(),Context.DEVICE_ID_DEFAULT));
    check(local.get(2,TimeUnit.SECONDS)==PackageManager.PERMISSION_DENIED,"unrelated local check completes while signer verification is pending");
   }
   grants.get(5,TimeUnit.SECONDS);
  }finally{executor.shutdownNow();executor.awaitTermination(5,TimeUnit.SECONDS);}
 }
}
