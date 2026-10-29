import android.app.AppOpsManager;
import android.content.Context;
import android.os.*;
import com.android.internal.app.*;
import java.nio.file.Path;
import maclauncher.android.fixture.MediaServicesFixture;
import maclauncher.android.framework.HostLooper;
import maclauncher.android.framework.HostActivityManager;
import maclauncher.android.framework.HostAppOps;

/** Original service/client mode, operation and callback ownership. */
public final class AppOpsServiceProbe {
    static void check(boolean value,String name){if(!value)throw new AssertionError(name);}
    static void drainUntil(Looper loop,java.util.function.BooleanSupplier complete)throws Exception{
        long end=System.nanoTime()+2_000_000_000L;
        while(!complete.getAsBoolean()&&System.nanoTime()<end){HostLooper.drain(loop);Thread.sleep(2);}
        check(complete.getAsBoolean(),"original app-op callback delivery");
    }
    static void settle(Looper loop)throws Exception{for(int i=0;i<20;i++){HostLooper.drain(loop);Thread.sleep(2);}}
    static java.util.Set<Integer> family(int switched){var result=new java.util.LinkedHashSet<Integer>();for(int op=0;op<AppOpsManager._NUM_OP;op++)if(AppOpsManager.opToSwitch(op)==switched)result.add(op);return result;}
    static final class ModeWatch extends IAppOpsCallback.Stub {
        final int uid;final String own;final java.util.List<Integer> ops=new java.util.ArrayList<>();
        ModeWatch(int uid,String own){this.uid=uid;this.own=own;}
        public void opChanged(int op,int changedUid,String changedPackage,String device){check(changedUid==uid&&own.equals(changedPackage)&&"default:0".equals(device),"watcher retains exact UID, package and device");ops.add(op);}
    }
    static void watcherIdentity(IAppOpsService service,AppOpsManager client,Looper loop,int uid,String own)throws Exception{
        int alias=0;while(alias<AppOpsManager._NUM_OP&&(AppOpsManager.opToSwitch(alias)==alias||AppOpsManager.opToSwitch(alias)<0))alias++;
        check(alias<AppOpsManager._NUM_OP,"selected original framework retains operation switch aliases");
        int child=alias,switched=AppOpsManager.opToSwitch(child);var all=family(switched);
        ModeWatch plain=new ModeWatch(uid,own),legacy=new ModeWatch(uid,own),packages=new ModeWatch(uid,own),legacyPackage=new ModeWatch(uid,own),both=new ModeWatch(uid,own),empty=new ModeWatch(uid,own);
        service.startWatchingMode(child,null,plain);
        service.startWatchingModeWithFlags(child,null,AppOpsManager.CALL_BACK_ON_SWITCHED_OP,legacy);
        service.startWatchingMode(AppOpsManager.OP_NONE,own,packages);
        service.startWatchingModeWithFlags(AppOpsManager.OP_NONE,own,AppOpsManager.CALL_BACK_ON_SWITCHED_OP,legacyPackage);
        service.startWatchingMode(child,own,both);
        service.startWatchingModeWithFlags(switched,own,AppOpsManager.CALL_BACK_ON_SWITCHED_OP,both);
        service.startWatchingMode(AppOpsManager.OP_NONE,null,empty);
        try{
            service.setUidMode(child,uid,AppOpsManager.MODE_ERRORED);drainUntil(loop,()->!plain.ops.isEmpty()&&!legacy.ops.isEmpty()&&packages.ops.size()>=all.size());settle(loop);
            check(plain.ops.equals(java.util.List.of(child)),"unflagged child watcher hears the original child");
            check(legacy.ops.equals(java.util.List.of(switched)),"legacy switched flag hears the switch operation");
            check(packages.ops.size()==all.size()&&new java.util.LinkedHashSet<>(packages.ops).equals(all),"OP_NONE package watcher expands the complete original switch family once");
            check(legacyPackage.ops.equals(java.util.List.of(switched)),"legacy OP_NONE package watcher hears one switch code");
            check(both.ops.equals(java.util.List.of(child)),"op/package buckets coalesce and later registration retains first callback identity and flags");
            check(empty.ops.isEmpty(),"OP_NONE without a package does not subscribe to all operations");
            check(client.unsafeCheckOpRawNoThrow(AppOpsManager.opToPublicName(child),uid,own)==AppOpsManager.MODE_ERRORED&&client.unsafeCheckOpRawNoThrow(AppOpsManager.opToPublicName(switched),uid,own)==AppOpsManager.MODE_ERRORED,"child and switch share one UID mode");
            service.setUidMode(child,uid,AppOpsManager.MODE_ERRORED);settle(loop);check(plain.ops.size()==1&&packages.ops.size()==all.size(),"unchanged switch-family mode has no callbacks");
            service.setUidMode(child,uid,AppOpsManager.MODE_IGNORED);service.setUidMode(switched,uid,AppOpsManager.MODE_ERRORED);settle(loop);
            check(plain.ops.size()==2&&legacy.ops.size()==2&&both.ops.size()==2&&packages.ops.size()==all.size()*2,"same-batch changes coalesce exact callback tuples");
        }finally{
            for(var callback:new ModeWatch[]{plain,legacy,packages,legacyPackage,both,empty})service.stopWatchingMode(callback);
            service.setUidMode(child,uid,AppOpsManager.opToDefaultMode(switched));settle(loop);
        }
    }
    static void foregroundWatchers(IAppOpsService service,AppOpsManager client,Looper loop,int uid,String own)throws Exception{
        int op=AppOpsManager.OP_PLAY_AUDIO,unrelated=AppOpsManager.OP_VIBRATE;var all=family(op);
        service.setMode(op,uid,own,AppOpsManager.MODE_ALLOWED);service.setUidMode(op,uid,AppOpsManager.MODE_FOREGROUND);service.setUidMode(unrelated,uid,AppOpsManager.MODE_ALLOWED);settle(loop);
        ModeWatch plain=new ModeWatch(uid,own),foreground=new ModeWatch(uid,own),other=new ModeWatch(uid,own),packages=new ModeWatch(uid,own),plainPackage=new ModeWatch(uid,own);
        service.startWatchingMode(op,null,plain);service.startWatchingModeWithFlags(op,null,AppOpsManager.WATCH_FOREGROUND_CHANGES,foreground);
        service.startWatchingModeWithFlags(unrelated,null,AppOpsManager.WATCH_FOREGROUND_CHANGES,other);
        service.startWatchingModeWithFlags(AppOpsManager.OP_NONE,own,AppOpsManager.WATCH_FOREGROUND_CHANGES,packages);service.startWatchingMode(AppOpsManager.OP_NONE,own,plainPackage);
        android.app.Activity first=new android.app.Activity(),second=new android.app.Activity();
        try{
            HostActivityManager.hostStarted(first);drainUntil(loop,()->!foreground.ops.isEmpty());settle(loop);
            check(client.checkOpNoThrow(op,uid,own)==AppOpsManager.MODE_ALLOWED,"foreground-only mode evaluates the actual started Activity");
            check(foreground.ops.equals(java.util.List.of(op))&&packages.ops.size()==all.size()&&new java.util.HashSet<>(packages.ops).equals(all),"UID foreground change notifies only the affected flagged switch family");
            check(plain.ops.isEmpty()&&plainPackage.ops.isEmpty()&&other.ops.isEmpty(),"UID transitions do not announce unflagged or unrelated operation modes");
            HostActivityManager.hostStarted(second);HostActivityManager.hostStopped(first);settle(loop);check(foreground.ops.size()==1,"unchanged foreground state has no duplicate notification");
            HostActivityManager.hostStopped(second);drainUntil(loop,()->foreground.ops.size()==2);settle(loop);
            check(packages.ops.size()==all.size()*2&&plain.ops.isEmpty()&&other.ops.isEmpty(),"background transition preserves foreground-only filtering");
            check(client.checkOpNoThrow(op,uid,own)==AppOpsManager.MODE_IGNORED,"foreground mode evaluates background state");
            service.setUidMode(op,uid,AppOpsManager.MODE_ALLOWED);settle(loop);for(var watch:new ModeWatch[]{plain,foreground,other,packages,plainPackage})watch.ops.clear();
            HostActivityManager.hostStarted(first);HostActivityManager.hostStopped(first);settle(loop);check(plain.ops.isEmpty()&&foreground.ops.isEmpty()&&other.ops.isEmpty()&&packages.ops.isEmpty()&&plainPackage.ops.isEmpty(),"no foreground mode means no UID mode announcement");
            service.setMode(op,uid,own,AppOpsManager.MODE_FOREGROUND);settle(loop);for(var watch:new ModeWatch[]{plain,foreground,other,packages,plainPackage})watch.ops.clear();
            HostActivityManager.hostStarted(first);drainUntil(loop,()->!foreground.ops.isEmpty());settle(loop);
            check(foreground.ops.equals(java.util.List.of(op))&&packages.ops.isEmpty()&&plain.ops.isEmpty()&&other.ops.isEmpty(),"package foreground mode follows original op-watcher routing");
        }finally{
            HostActivityManager.hostStopped(first);HostActivityManager.hostStopped(second);
            for(var watch:new ModeWatch[]{plain,foreground,other,packages,plainPackage})service.stopWatchingMode(watch);
            service.setMode(op,uid,own,AppOpsManager.MODE_ALLOWED);service.setUidMode(op,uid,AppOpsManager.MODE_ALLOWED);settle(loop);
        }
    }
    public static void main(String[] args)throws Exception {
        try(var services=new MediaServicesFixture(Path.of(args[0]),Path.of(args[1]))){
            Context context=services.context;Looper loop=services.loop;
            AppOpsManager client=context.getSystemService(AppOpsManager.class);
            int uid=android.os.Process.myUid();String own=context.getPackageName();
            IAppOpsService service=IAppOpsService.Stub.asInterface(ServiceManager.getService(Context.APP_OPS_SERVICE));
            check(service!=null&&service.asBinder().isBinderAlive()&&
                "com.android.internal.app.IAppOpsService".equals(service.asBinder().getInterfaceDescriptor()),
                "live application-operation owner retains the original Binder contract");
            int original=client.unsafeCheckOpRawNoThrow(AppOpsManager.OPSTR_PLAY_AUDIO,uid,own);
            int[] changes={0};IAppOpsCallback callback=new IAppOpsCallback.Stub(){public void opChanged(int op,int changedUid,String changedPackage,String device){check(op==AppOpsManager.OP_PLAY_AUDIO&&changedUid==uid&&own.equals(changedPackage)&&"default:0".equals(device),"mode callback retains operation, UID, package and device");changes[0]++;}};
            service.startWatchingMode(AppOpsManager.OP_PLAY_AUDIO,own,callback);
            try {
                service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_IGNORED);
                drainUntil(loop,()->changes[0]>0);
                check(client.checkOpNoThrow(AppOpsManager.OP_PLAY_AUDIO,uid,own)==AppOpsManager.MODE_IGNORED,"original mode changes reach client");
                int beforeNoop=changes[0];service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_IGNORED);
                for(int i=0;i<20;i++){HostLooper.drain(loop);Thread.sleep(2);}
                check(changes[0]==beforeNoop,"unchanged UID mode does not notify watchers");
                var decisions=context.createDeviceProtectedStorageContext().getSharedPreferences("maclauncher.platform.permission-decisions",Context.MODE_PRIVATE);
                check(decisions.getInt("appop:uid:"+uid+":"+AppOpsManager.OPSTR_PLAY_AUDIO,-1)==AppOpsManager.MODE_IGNORED,"UID mode uses the existing persisted decision owner");
                android.app.QueuedWork.waitToFinish();
                check(java.nio.file.Files.readString(context.createDeviceProtectedStorageContext().getSharedPreferencesPath("maclauncher.platform.permission-decisions").toPath()).contains("appop:uid:"+uid+":"+AppOpsManager.OPSTR_PLAY_AUDIO),"original preference writer commits UID mode to disk");
                service.setMode(AppOpsManager.OP_PLAY_AUDIO,uid,own,AppOpsManager.MODE_ERRORED);
                check(client.unsafeCheckOpRawNoThrow(AppOpsManager.OPSTR_PLAY_AUDIO,uid,own)==AppOpsManager.MODE_IGNORED,"nondefault UID mode takes precedence over package mode");
                service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_ALLOWED);
                check(client.unsafeCheckOpRawNoThrow(AppOpsManager.OPSTR_PLAY_AUDIO,uid,own)==AppOpsManager.MODE_ERRORED,"reset UID default reveals retained package mode");
                service.setMode(AppOpsManager.OP_PLAY_AUDIO,uid,own,AppOpsManager.MODE_ALLOWED);
                service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_FOREGROUND);
                check(client.unsafeCheckOpRawNoThrow(AppOpsManager.OPSTR_PLAY_AUDIO,uid,own)==AppOpsManager.MODE_FOREGROUND,"raw query retains foreground mode");
                check(client.checkOpNoThrow(AppOpsManager.OP_PLAY_AUDIO,uid,own)==AppOpsManager.MODE_IGNORED,"foreground mode is denied while no Activity is started");
                service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_ALLOWED);
                IBinder token=new Binder();
                check(service.startOperation(token,AppOpsManager.OP_PLAY_AUDIO,uid,own,null,false,false,null,false,0,0).getOpMode()==AppOpsManager.MODE_ALLOWED,"original noted result");
                check(service.startOperation(token,AppOpsManager.OP_PLAY_AUDIO,uid,own,null,false,false,null,false,0,0).getOpMode()==AppOpsManager.MODE_ALLOWED,"nested operation retained");
                check(service.isOperationActive(AppOpsManager.OP_PLAY_AUDIO,uid,own),"original active operation");
                service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_ERRORED);settle(loop);
                check(service.isOperationActive(AppOpsManager.OP_PLAY_AUDIO,uid,own),"ERRORED write preserves a running operation after callback dispatch");
                service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_IGNORED);
                settle(loop);
                check(!service.isOperationActive(AppOpsManager.OP_PLAY_AUDIO,uid,own),"mode restriction pauses active operation");
                service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_ERRORED);settle(loop);
                check(!service.isOperationActive(AppOpsManager.OP_PLAY_AUDIO,uid,own),"ERRORED write preserves a paused operation");
                service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_FOREGROUND);settle(loop);
                check(service.isOperationActive(AppOpsManager.OP_PLAY_AUDIO,uid,own)&&client.checkOpNoThrow(AppOpsManager.OP_PLAY_AUDIO,uid,own)==AppOpsManager.MODE_IGNORED,"FOREGROUND write resumes accounting even while its effective background mode is ignored");
                service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_IGNORED);
                service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_DEFAULT);settle(loop);
                check(service.isOperationActive(AppOpsManager.OP_PLAY_AUDIO,uid,own)&&client.unsafeCheckOpRawNoThrow(AppOpsManager.OPSTR_PLAY_AUDIO,uid,own)==AppOpsManager.MODE_DEFAULT,"DEFAULT write resumes accounting without substituting an effective permission result");
                service.setMode(AppOpsManager.OP_PLAY_AUDIO,uid,own,AppOpsManager.MODE_IGNORED);settle(loop);
                check(service.isOperationActive(AppOpsManager.OP_PLAY_AUDIO,uid,own),"written started-op update skips a package mode outside ALLOWED or FOREGROUND");
                service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_IGNORED);settle(loop);
                check(service.isOperationActive(AppOpsManager.OP_PLAY_AUDIO,uid,own),"UID write preserves the original package-mode guard");
                service.setMode(AppOpsManager.OP_PLAY_AUDIO,uid,own,AppOpsManager.MODE_ALLOWED);
                IBinder restriction=new Binder();HostAppOps.hostSetGlobalRestriction(null,AppOpsManager.OP_PLAY_AUDIO,true,restriction);settle(loop);
                service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_FOREGROUND);settle(loop);
                check(!service.isOperationActive(AppOpsManager.OP_PLAY_AUDIO,uid,own),"mode writes do not resume through a retained global restriction");
                HostAppOps.hostSetGlobalRestriction(null,AppOpsManager.OP_PLAY_AUDIO,false,restriction);settle(loop);
                service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_ALLOWED);
                check(service.isOperationActive(AppOpsManager.OP_PLAY_AUDIO,uid,own),"mode restoration resumes the same operation");
                service.finishOperation(token,AppOpsManager.OP_PLAY_AUDIO,uid,own,null);
                check(service.isOperationActive(AppOpsManager.OP_PLAY_AUDIO,uid,own),"paused/resumed operation retains nested count");
                service.finishOperation(token,AppOpsManager.OP_PLAY_AUDIO,uid,own,null);
                check(!service.isOperationActive(AppOpsManager.OP_PLAY_AUDIO,uid,own),"original operation retires");
                HostLooper.drain(loop);service.stopWatchingMode(callback);
                int before=changes[0];service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,AppOpsManager.MODE_IGNORED);
                for(int i=0;i<20;i++){HostLooper.drain(loop);Thread.sleep(2);}
                check(changes[0]==before,"callback retirement");
                try{service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,-1);throw new AssertionError("invalid mode accepted");}catch(IllegalArgumentException expected){}
                try{service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid+1,AppOpsManager.MODE_ALLOWED);throw new AssertionError("foreign UID owner accepted");}catch(SecurityException expected){}
                watcherIdentity(service,client,loop,uid,own);
                foregroundWatchers(service,client,loop,uid,own);
            }finally{service.stopWatchingMode(callback);service.setMode(AppOpsManager.OP_PLAY_AUDIO,uid,own,AppOpsManager.MODE_ALLOWED);service.setUidMode(AppOpsManager.OP_PLAY_AUDIO,uid,original);}
        }
        System.out.println("PASS raw AppOps client, original modes, active operations and callback retirement");
        System.exit(0);
    }
}
