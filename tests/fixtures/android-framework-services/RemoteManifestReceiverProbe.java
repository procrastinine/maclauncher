package maclauncher.android.framework;

import android.app.*;
import android.content.*;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import maclauncher.android.fixture.RuntimeFixture;

/** Original manifest receiver dispatch across actual process and Binder boundaries. */
public final class RemoteManifestReceiverProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static final class RemoteReceiver extends BroadcastReceiver {
        @Override public void onReceive(Context context,Intent intent){
            check(Looper.myLooper()==Looper.getMainLooper(),"manifest receiver runs on original ActivityThread main Looper");
            check(context.getPackageName().equals("fixture.server"),"receiver context belongs to original package");
            check(HostContext.hostProcessName().equals("fixture.server:receivers"),"manifest receiver runs in declared process");
            check(getSentFromUid()==10002&&"fixture.client".equals(getSentFromPackage()),"remote sender identity is preserved");
            PendingResult pending=goAsync();
            new Thread(()->{try{Thread.sleep(25);Bundle extras=new Bundle();extras.putInt("pid",android.os.Process.myPid());extras.putBoolean("original",true);pending.setResult(42,"remote",extras);}catch(InterruptedException error){throw new AssertionError(error);}finally{pending.finish();}},"receiver-result").start();
        }
    }
    public static final class PrivateReceiver extends BroadcastReceiver {
        @Override public void onReceive(Context context,Intent intent){throw new AssertionError("nonexported receiver was delivered across packages");}
    }
    public static final class LocalReceiver extends BroadcastReceiver {
        @Override public void onReceive(Context context,Intent intent){check(Looper.myLooper()==Looper.getMainLooper(),"local original main receiver");setResultCode(73);setResultData("local");}
    }
    static final class Result extends BroadcastReceiver {
        boolean done;int code;String data;Bundle extras;
        @Override public void onReceive(Context context,Intent intent){code=getResultCode();data=getResultData();extras=getResultExtras(false);done=true;}
    }
    static Result send(Context context,Looper loop,Intent intent)throws Exception{
        Result result=new Result();context.sendOrderedBroadcast(intent,null,result,new Handler(loop),7,"initial",null);
        long end=System.nanoTime()+5_000_000_000L;while(!result.done&&System.nanoTime()<end){HostLooper.drain(loop);Thread.sleep(2);}
        check(result.done,"ordered receiver result completed without timeout");return result;
    }
    public static void main(String[] args)throws Exception{
        String role=args[0],other=role.equals("server")?"client":"server";boolean server=role.equals("server");
        Path root=Path.of(args[3]),data=Files.createDirectories(root.resolve(role)),runtime=Path.of(args[2]);
        int uid=server?10001:10002,peerUid=server?10002:10001;
        Looper loop=RuntimeFixture.initialize(runtime.toString(),data.toString(),runtime.resolve("native/libklepton-graphics.dylib").toString());
        HostProcessIdentity.configure(uid,(int)new com.sun.security.auth.module.UnixSystem().getUid());
        Files.writeString(root.resolve(role+"-android-pid"),Integer.toString(android.os.Process.myPid()));
        long identityDeadline=System.nanoTime()+5_000_000_000L;while(!Files.exists(root.resolve(other+"-android-pid"))&&System.nanoTime()<identityDeadline)Thread.sleep(5);
        int peerPid=Integer.parseInt(Files.readString(root.resolve(other+"-android-pid")));
        Path apk=root.resolve(role+".apk");HostContext.hostPackage("fixture."+role,"1",1);
        HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);HostContext.hostApplicationIdentity(uid,0);
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));HostPackages.inspectSources(List.of(apk));
        HostContext.hostProcessName(server?"fixture.server:receivers":"fixture.client");
        var installed=new org.json.JSONObject().put("packageName","fixture."+other).put("sourceApks",new org.json.JSONArray().put(root.resolve(other+".apk").toString())).put("dataRoot",root.resolve(other).toString()).put("nativeRoot",root.resolve(other).toString()).put("uid",peerUid).put("firstInstallTime",1).put("lastUpdateTime",1);
        HostPackages.inspectInstalled(new org.json.JSONArray().put(installed).toString());HostStorageService.install();HostApplication.prepare(RemoteManifestReceiverProbe.class.getClassLoader());
        Context context=HostApplication.applicationContext();Application app=new Application();HostApplication.attach(app,context);HostApplication.create(app);
        var peer=new HostBinderRpc.Peer("fixture."+other,server?"fixture.client":"fixture.server:receivers",peerPid,peerUid);
        try(var bootstrap=ParcelFileDescriptor.adoptFd(Integer.parseInt(args[5]));var directory=new HostServiceDirectory(context)){
            if(server){
                var connection=HostBinderRpc.serve(bootstrap,peer,directory.root(),4);
                long end=System.nanoTime()+15_000_000_000L;while(!Files.exists(root.resolve("client-done"))&&System.nanoTime()<end){HostLooper.drain(loop);Thread.sleep(2);}
                check(Files.exists(root.resolve("client-done")),"remote manifest client completed");connection.close();connection.closed().toCompletableFuture().get(5,TimeUnit.SECONDS);
            }else{
                var connection=HostBinderRpc.connect(bootstrap,peer,4);HostRemoteServices.attach(connection,connection.root());
                Result remote=send(context,loop,new Intent("fixture.REMOTE").setComponent(new ComponentName("fixture.server",RemoteReceiver.class.getName())));
                check(remote.code==42&&"remote".equals(remote.data)&&remote.extras.getBoolean("original")&&remote.extras.getInt("pid")==peer.pid(),"original goAsync ordered result returns across process boundary");
                Result implicit=send(context,loop,new Intent("fixture.REMOTE").setPackage("fixture.server"));check(implicit.code==42,"manifest filter resolves across process boundary");
                Result denied=send(context,loop,new Intent().setComponent(new ComponentName("fixture.server",PrivateReceiver.class.getName())));check(denied.code==7&&"initial".equals(denied.data),"private receiver remains inaccessible");
                Result local=send(context,loop,new Intent().setComponent(new ComponentName("fixture.client",LocalReceiver.class.getName())));check(local.code==73&&"local".equals(local.data),"same-package nonexported receiver remains available");
                Files.writeString(root.resolve("client-done"),"done");HostRemoteServices.shutdown();connection.closed().toCompletableFuture().get(5,TimeUnit.SECONDS);
                System.out.println("PASS original manifest receivers: local, remote declared process, sender identity, filter resolution, permission and ordered goAsync result");
            }
        }finally{HostRemoteServices.shutdown();HostApplication.shutdown();HostWindowManager.shutdown();FrameworkResources.shutdown();HostLooper.close(loop);HostContext.hostShutdown();}
    }
}
