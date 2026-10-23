package maclauncher.android.fixture;

import android.app.Application;
import android.content.pm.*;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.*;

/** Original native AIDL over the canonical parsed package catalog, without a game. */
public final class NativePackagesProbe {
 private static native void probe(int socket,int sdk,long version,boolean capture,boolean debug);
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args){try{run(args);System.exit(0);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
 static void run(String[] args)throws Exception{
  Path runtime=Path.of(args[0]),data=Path.of(args[1]);Looper loop=RuntimeFixture.initialize(args[0],args[1]);System.load(args[2]);
  HostProcessIdentity.configure(android.os.Process.SYSTEM_UID,android.system.Os.getuid());
  Path framework=runtime.resolve("android-framework.jar");FrameworkResources.configure(framework,List.of(framework));
  HostContext.hostPackage("android","16",1);HostContext.hostApplicationInfo(0,framework.toString(),data.toString(),runtime.resolve("native").toString(),0);HostContext.hostApplicationIdentity(android.os.Process.SYSTEM_UID,0);
  HostPackages.inspectSources(List.of(framework));HostStorageService.install();HostApplication.prepare(NativePackagesProbe.class.getClassLoader());
  var context=HostApplication.applicationContext();HostApplication.attach(new Application(),context);
  try(var owner=new HostNativePackages(context)){
   var service=IPackageManagerNative.Stub.asInterface(HostServices.publishedManager().checkService("package_native"));check(service==owner,"one published package metadata owner");
   for(var method:IPackageManagerNative.class.getDeclaredMethods())check(HostNativePackages.class.getMethod(method.getName(),method.getParameterTypes()).getDeclaringClass()==HostNativePackages.class,"complete typed native contract: "+method);
   var info=HostPackages.service().getApplicationInfo("android",0,0);long version=HostPackages.service().getPackageInfo("android",0,0).getLongVersionCode();
   service.registerStagedApexObserver(null);service.unregisterStagedApexObserver(null);
   var sockets=ParcelFileDescriptor.createSocketPair();
   var peer=new HostBinderRpc.Peer("fixture.native.packages","fixture.native.packages",android.os.Process.myPid(),android.os.Process.myUid());
   try(var server=HostBinderRpc.serve(sockets[0],peer,HostServices.publishedManager().asBinder(),4)){
    try{probe(sockets[1].getFd(),info.targetSdkVersion,version,info.isAudioPlaybackCaptureAllowed(),(info.flags&ApplicationInfo.FLAG_DEBUGGABLE)!=0);}
    finally{sockets[0].close();sockets[1].close();}
   }
  }finally{HostApplication.shutdown();HostLooper.close(loop);FrameworkResources.shutdown();}
  check(HostServices.manager().checkService("package_native")==null,"native metadata endpoint retired");
  System.out.println("PASS complete original native package AIDL: catalog, target SDK, flags, certificates, features, observers and retirement");
 }
}
