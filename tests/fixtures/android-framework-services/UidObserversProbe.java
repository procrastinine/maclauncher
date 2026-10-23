import android.app.*;
import android.content.*;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;

public final class UidObserversProbe {
    private static void check(boolean value,String text){if(!value)throw new AssertionError(text);}
    private static final class Observer extends IUidObserver.Stub {
        final List<Integer> states=new ArrayList<>();final List<Boolean> cached=new ArrayList<>();
        IActivityManager owner;boolean remove;
        @Override public void onUidStateChanged(int uid,int state,long sequence,int capabilities)throws RemoteException{
            states.add(state);if(remove)owner.unregisterUidObserver(this);
        }
        @Override public void onUidCachedChanged(int uid,boolean value){cached.add(value);}
        @Override public void onUidGone(int uid,boolean disabled){}
        @Override public void onUidActive(int uid){}
        @Override public void onUidIdle(int uid,boolean disabled){}
        @Override public void onUidProcAdjChanged(int uid,int adjustment){}
    }
    public static void main(String[] args){try{run(args);}catch(Throwable error){error.printStackTrace();System.exit(1);}}
    private static void run(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Path.of(args[1]),framework=runtime.resolve("android-framework.jar");
        var loop=RuntimeFixture.initialize(args[0],args[1]);HostProcessIdentity.configure(1000,501);
        FrameworkResources.configure(framework,List.of(framework));HostContext.hostPackage("android","16",1);
        HostContext.hostApplicationInfo(0,framework.toString(),data.toString(),runtime.resolve("native").toString(),0);HostContext.hostApplicationIdentity(1000,0);
        HostPackages.inspectSources(List.of(framework));HostStorageService.install();
        HostApplication.prepare(UidObserversProbe.class.getClassLoader());Context context=HostApplication.applicationContext();HostApplication.attach(new Application(),context);
        HostLooper.drain(loop);
        IActivityManager service=ActivityManager.getService();int uid=android.os.Process.myUid();
        Observer observer=new Observer();observer.owner=service;
        Observer filtered=new Observer();filtered.owner=service;
        int which=ActivityManager.UID_OBSERVER_PROCSTATE|ActivityManager.UID_OBSERVER_CACHED;
        service.registerUidObserver(observer,which,ActivityManager.PROCESS_STATE_TOP,"android");
        IBinder token=service.registerUidObserverForUids(filtered,which,ActivityManager.PROCESS_STATE_TOP,"android",new int[]{uid+1});
        Activity first=new Activity(),second=new Activity();
        HostActivityManager.hostStarted(first);HostLooper.drain(loop);
        check(observer.states.equals(List.of(ActivityManager.PROCESS_STATE_TOP)),"Original foreground transition");
        check(filtered.states.isEmpty(),"Original UID filter");
        HostActivityManager.hostStarted(second);HostActivityManager.hostStopped(first);HostLooper.drain(loop);
        check(observer.states.size()==1,"One UID state for multiple Activities");
        service.addUidToObserver(token,"android",uid);HostLooper.drain(loop);
        HostActivityManager.hostStopped(second);HostLooper.drain(loop);
        check(observer.states.equals(List.of(ActivityManager.PROCESS_STATE_TOP,ActivityManager.PROCESS_STATE_CACHED_EMPTY)),"Original cutpoint transition");
        check(filtered.states.equals(List.of(ActivityManager.PROCESS_STATE_CACHED_EMPTY)),"Original dynamic UID filter addition");
        check(observer.cached.equals(List.of(false,true)),"Original cache callbacks");
        service.removeUidFromObserver(token,"android",uid);HostLooper.drain(loop);
        observer.remove=true;HostActivityManager.hostStarted(first);HostLooper.drain(loop);
        HostActivityManager.hostStopped(first);HostLooper.drain(loop);
        check(observer.states.size()==3,"Reentrant callback retirement without owner lock");
        check(filtered.states.size()==1,"Original dynamic UID filter removal");
        var frozen=new IUidFrozenStateChangedCallback.Stub(){@Override public void onUidFrozenStateChanged(int[] uids,int[] states){throw new AssertionError("Invented freezer event");}};
        service.registerUidFrozenStateChangedCallback(frozen);
        check(Arrays.stream(service.getUidFrozenState(new int[]{uid,uid+1})).allMatch(state->state==ActivityManager.UidFrozenStateChangedCallback.UID_FROZEN_STATE_UNFROZEN),"Real host has no Android cgroup freezer");
        service.unregisterUidFrozenStateChangedCallback(frozen);service.unregisterUidObserver(filtered);
        HostApplication.shutdown();HostLooper.close(loop);FrameworkResources.shutdown();
        System.out.println("PASS original UID observer filtering, lifecycle, cutpoint and callback retirement");
    }
}
