package maclauncher.android.tests;

import android.app.PendingIntent;
import android.content.*;
import android.os.*;
import java.net.URLClassLoader;
import java.nio.file.Path;
import maclauncher.android.framework.HostLooper;

/** Original intent tokens, parcels and callbacks through the local activity service. */
public final class IntentSenderProbe {
    private static void check(boolean condition){if(!condition)throw new AssertionError();}
    private static void original(String jar)throws Exception{
        try(var loader=new URLClassLoader(new java.net.URL[]{Path.of(jar).toUri().toURL()},IntentSenderProbe.class.getClassLoader())){
            Class<?> callback=Class.forName("androidx.activity.ComponentActivity$2",false,loader);check(callback.getDeclaredConstructors().length>0&&callback.getDeclaredMethods().length>0);
            Class<?> request=Class.forName("androidx.activity.result.IntentSenderRequest",true,loader);var constructor=request.getDeclaredConstructor(IntentSender.class,Intent.class,int.class,int.class);constructor.setAccessible(true);Object value=constructor.newInstance(null,null,0x40,0x20);
            check(request.getMethod("getIntentSender").invoke(value)==null&&request.getMethod("getFillInIntent").invoke(value)==null);check((int)request.getMethod("getFlagsMask").invoke(value)==0x40&&(int)request.getMethod("getFlagsValues").invoke(value)==0x20);
        }
    }
    public static void run(Context context)throws Exception{
        Exception cause=new Exception("original");check(new IntentSender.SendIntentException(cause).getCause()==cause&&new PendingIntent.CanceledException(cause).getCause()==cause);
        int[] flags={PendingIntent.FLAG_ONE_SHOT,PendingIntent.FLAG_NO_CREATE,PendingIntent.FLAG_CANCEL_CURRENT,PendingIntent.FLAG_UPDATE_CURRENT,PendingIntent.FLAG_IMMUTABLE,PendingIntent.FLAG_MUTABLE,PendingIntent.FLAG_ALLOW_UNSAFE_IMPLICIT_INTENT};for(int i=0;i<flags.length;i++)check(flags[i]==1<<(30-i));check(PendingIntent.FLAG_MUTABLE_UNAUDITED==PendingIntent.FLAG_MUTABLE);
        Intent intent=new Intent("owned.INTENT_SENDER").setPackage(context.getPackageName());int noCreate=PendingIntent.FLAG_NO_CREATE|PendingIntent.FLAG_IMMUTABLE;
        check(PendingIntent.getBroadcast(context,3101,intent,noCreate)==null&&PendingIntent.getActivity(context,3101,intent,noCreate)==null&&PendingIntent.getService(context,3101,intent,noCreate)==null&&PendingIntent.getForegroundService(context,3101,intent,noCreate)==null);
        int[] received={0},finished={0};BroadcastReceiver receiver=new BroadcastReceiver(){public void onReceive(Context owner,Intent value){check(value.getAction().equals(intent.getAction()));received[0]++;}};
        context.registerReceiver(receiver,new IntentFilter(intent.getAction()),Context.RECEIVER_NOT_EXPORTED);
        PendingIntent pending=PendingIntent.getBroadcast(context,3101,intent,PendingIntent.FLAG_IMMUTABLE);IntentSender sender=pending.getIntentSender();
        try{
            check(pending.isImmutable()&&pending.getCreatorPackage().equals(context.getPackageName())&&pending.getCreatorUid()==android.os.Process.myUid());
            check(PendingIntent.getBroadcast(context,3101,intent,noCreate).equals(pending));
            Parcel parcel=Parcel.obtain();try{sender.writeToParcel(parcel,0);pending.writeToParcel(parcel,0);parcel.setDataPosition(0);check(IntentSender.CREATOR.createFromParcel(parcel).equals(sender)&&PendingIntent.CREATOR.createFromParcel(parcel).equals(pending));}finally{parcel.recycle();}
            sender.sendIntent(context,42,null,(owner,value,code,data,extras)->{check(owner.equals(sender)&&code==42);finished[0]++;},null);HostLooper.drain(Looper.getMainLooper());check(received[0]==1&&finished[0]==1);
            pending.cancel();check(PendingIntent.getBroadcast(context,3101,intent,noCreate)==null);
            try{sender.sendIntent(context,0,null,null,null);throw new AssertionError("Cancelled sender accepted");}catch(IntentSender.SendIntentException expected){}
            try{pending.send();throw new AssertionError("Cancelled pending intent accepted");}catch(PendingIntent.CanceledException expected){}
            check(IntentSender.CREATOR.newArray(3).length==3&&PendingIntent.CREATOR.newArray(3).length==3);
        }finally{pending.cancel();context.unregisterReceiver(receiver);}
    }
    public static void main(String[] args)throws Exception{if(args.length!=2||!args[0].equals("linkage"))throw new IllegalArgumentException("Expected linkage and converted AndroidX JAR");original(args[1]);System.out.println("PASS original AndroidX intent sender linkage");}
}
