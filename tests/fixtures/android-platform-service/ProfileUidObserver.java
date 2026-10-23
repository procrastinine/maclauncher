package maclauncher.android;

import android.app.*;
import android.content.Context;
import android.os.*;
import java.nio.file.*;

/** Test observer installed inside the genuine profile system process. */
public final class ProfileUidObserver {
    public static void install(Context context) {
        try {
            if (android.os.Process.myUid()!=android.os.Process.SYSTEM_UID) throw new AssertionError("Observer requires the real system identity");
            Path events=context.getFilesDir().toPath().resolve("uid-events.txt");
            Files.writeString(events,"");
            // Observe the genuine HostAudioPermissions owner's original
            // AudioServerPermissionProvider through its typed native endpoint.
            Path audio=context.getFilesDir().toPath().resolve("audio-package-events.txt");Files.writeString(audio,"");
            var permissions=new com.android.media.permission.INativePermissionController.Stub(){
                public void populatePackagesForUids(java.util.List<com.android.media.permission.UidPackageState> values){for(var value:values)updatePackagesForUid(value);}
                public synchronized void updatePackagesForUid(com.android.media.permission.UidPackageState value){
                    try{Files.writeString(audio,value.uid+":"+String.join(",",value.packageNames)+"\n",StandardOpenOption.APPEND);}
                    catch(java.io.IOException failure){throw new java.io.UncheckedIOException(failure);}
                }
                public void populatePermissionState(byte permission,int[] uids){}
            };
            Binder policyBinder=new Binder();
            var policy=(android.media.IAudioPolicyService)java.lang.reflect.Proxy.newProxyInstance(ProfileUidObserver.class.getClassLoader(),new Class<?>[]{android.media.IAudioPolicyService.class},(self,method,args)->switch(method.getName()){
                case "asBinder"->policyBinder;case "getPermissionController"->permissions;
                case "toString"->"Audio permission fixture";case "hashCode"->System.identityHashCode(self);case "equals"->self==args[0];
                default->throw new AssertionError("Unexpected audio operation "+method.getName());
            });
            policyBinder.attachInterface(policy,android.media.IAudioPolicyService.DESCRIPTOR);
            ServiceManager.addService("media.audio_policy",policyBinder);
            IActivityManager.Stub.asInterface(ServiceManager.getService(Context.ACTIVITY_SERVICE)).registerUidObserver(new IUidObserver.Stub() {
                private synchronized void record(int uid,int state) {
                    try { Files.writeString(events,uid+":"+state+"\n",StandardOpenOption.APPEND); }
                    catch(java.io.IOException failure) { throw new java.io.UncheckedIOException(failure); }
                }
                public void onUidStateChanged(int uid,int state,long sequence,int capabilities){record(uid,state);}
                public void onUidGone(int uid,boolean disabled){record(uid,ActivityManager.PROCESS_STATE_NONEXISTENT);}
                public void onUidActive(int uid){} public void onUidIdle(int uid,boolean disabled){}
                public void onUidCachedChanged(int uid,boolean cached){} public void onUidProcAdjChanged(int uid,int adj){}
            },ActivityManager.UID_OBSERVER_PROCSTATE|ActivityManager.UID_OBSERVER_GONE,ActivityManager.PROCESS_STATE_UNKNOWN,"android");
        } catch(Exception failure) { throw new RuntimeException(failure); }
    }
}
