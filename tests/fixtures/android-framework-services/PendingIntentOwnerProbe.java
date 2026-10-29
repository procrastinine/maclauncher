package maclauncher.android;

import android.app.*;
import android.content.*;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.*;
import maclauncher.android.fixture.RuntimeFixture;

/** The original controller owns token identity, replacement, cancellation and delivery. */
public final class PendingIntentOwnerProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static IBinder proxy(IBinder endpoint){return new Binder(){@Override public IInterface queryLocalInterface(String descriptor){return null;}@Override protected boolean onTransact(int code,Parcel data,Parcel reply,int flags)throws RemoteException{return endpoint.transact(code,data,reply,flags);}};}
    public static void main(String[] args)throws Exception{
        Looper loop=RuntimeFixture.initialize(args[0],args[1]);System.load(System.getProperty("klepton.graphics"));Path data=Path.of(args[1]),apk=data.resolve("pending.apk");
        maclauncher.android.SyntheticResources.apk(apk,"","Pending intent",null);
        maclauncher.android.fixture.PackageManifest.add(apk,"window");
        FrameworkResources.configure(Path.of(args[0],"android-framework.jar"),List.of(apk));
        HostContext.hostPackage("org.example.window","1",1);
        HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostDisplay.hostPublish(1,320,240,60);HostPackages.inspectSources(List.of(apk));
        HostApplication.prepare(PendingIntentOwnerProbe.class.getClassLoader());Context context=HostApplication.applicationContext();boolean queueClosed=false;
        try{
            IActivityManager manager=ActivityManager.getService();
            Intent intent=new Intent("fixture.PENDING").setPackage(context.getPackageName()).putExtra("version",1);
            int flags=PendingIntent.FLAG_IMMUTABLE;int[] delivered={0},version={0},cancelled={0};
            BroadcastReceiver receiver=new BroadcastReceiver(){public void onReceive(Context context,Intent intent){delivered[0]++;version[0]=intent.getIntExtra("version",0);}};
            context.registerReceiver(receiver,new IntentFilter(intent.getAction()),Context.RECEIVER_NOT_EXPORTED);
            PendingIntent pending=PendingIntent.getBroadcast(context,81,intent,flags);
            check(HostServiceClients.argument(pending.getTarget()).getClass().getName().equals("com.android.server.am.PendingIntentRecord"),"upstream token owner");
            check(pending.getTarget().asBinder()==((IInterface)HostServiceClients.argument(pending.getTarget())).asBinder(),"typed client preserves original Binder capability");
            check(pending.getCreatorUid()==android.os.Process.myUid()&&pending.getCreatorPackage().equals(context.getPackageName()),"original creator identity");
            PendingIntent updated=PendingIntent.getBroadcast(context,81,new Intent(intent).putExtra("version",2),flags|PendingIntent.FLAG_UPDATE_CURRENT);
            check(pending.equals(updated),"upstream update-current identity");
            pending.send();HostLooper.drain(loop);check(delivered[0]==1&&version[0]==2,"original extra replacement and broadcast destination");
            var listener=new com.android.internal.os.IResultReceiver.Stub(){public void send(int code,Bundle data){cancelled[0]++;}};
            check(manager.registerIntentSenderCancelListenerEx(pending.getTarget(),listener),"upstream cancellation listener");
            PendingIntent replaced=PendingIntent.getBroadcast(context,81,intent,flags|PendingIntent.FLAG_CANCEL_CURRENT);HostLooper.drain(loop);
            check(!replaced.equals(pending)&&cancelled[0]==1,"replacement cancels original token once");
            try{pending.send();throw new AssertionError("cancelled token accepted");}catch(PendingIntent.CanceledException expected){}
            PendingIntent once=PendingIntent.getBroadcast(context,82,intent,flags|PendingIntent.FLAG_ONE_SHOT);once.send();HostLooper.drain(loop);
            try{once.send();throw new AssertionError("one-shot token reused");}catch(PendingIntent.CanceledException expected){}
            PendingIntent missing=PendingIntent.getActivity(context,90,new Intent("fixture.NO_ACTIVITY"),flags);
            int result=ActivityTaskManager.getService().startActivityIntentSender(null,missing.getTarget(),null,null,null,new Binder(),"result",7,0,0,null);
            check(result==ActivityManager.START_INTENT_NOT_RESOLVED,"absent Activity is not silently accepted: "+result);
            var dispatched=IActivityTaskManager.Stub.asInterface(proxy(HostServiceEndpoints.export(ActivityTaskManager.getService(),IActivityTaskManager.DESCRIPTOR,context)));
            result=dispatched.startActivityIntentSender(null,missing.getTarget(),null,null,null,new Binder(),"result",7,0,0,null);
            check(result==ActivityManager.START_INTENT_NOT_RESOLVED,"original AIDL dispatch preserves returned PendingIntent owner: "+result);
            Intent absent=new Intent("fixture.OPTIONAL_SERVICE").setPackage(context.getPackageName());
            ServiceConnection connection=new ServiceConnection(){public void onServiceConnected(ComponentName name,IBinder binder){throw new AssertionError("Missing service connected");}public void onServiceDisconnected(ComponentName name){}};
            check(!context.bindService(absent,connection,Context.BIND_AUTO_CREATE),"optional missing bind returns false");
            context.unbindService(connection);
            check(context.startService(absent)==null&&!context.stopService(absent),"optional missing start/stop retain absence");
            check(manager.bindServiceInstance(null,null,absent,null,null,0,null,"another.package",context.getUserId())==-1,"unauthorized caller remains denied even for missing service");
            context.unregisterReceiver(receiver);replaced.cancel();missing.cancel();HostLooper.drain(loop);
            PendingIntent retiring=PendingIntent.getBroadcast(context,91,intent,flags);
            // Authority retirement closes the real queue before application
            // cleanup; its original token owner must precede alarm teardown.
            HostLooper.close(loop);queueClosed=true;
            try{retiring.send();throw new AssertionError("retired owner token accepted");}catch(PendingIntent.CanceledException expected){}
        }finally{HostApplication.shutdown();if(!queueClosed)HostLooper.drain(loop);HostWindowManager.shutdown();HostDisplay.hostShutdown();HostDisplay.hostRemove();FrameworkResources.shutdown();HostLooper.close(loop);HostContext.hostShutdown();}
        System.out.println("PASS original PendingIntent owner, identity, update/cancel/one-shot and truthful Activity dispatch");
    }
}
