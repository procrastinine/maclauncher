package maclauncher.android;

import android.app.*;
import android.content.*;
import android.os.Parcel;
import maclauncher.android.framework.HostActivityManager;

/** Original context permission/attribution and ActivityManager APIs over local process records. */
public final class ProcessHistoryProbe {
    private static void check(boolean value){if(!value)throw new AssertionError("Original process client contract");}
    public static void run(Context context)throws Exception{
        int pid=android.os.Process.myPid(),uid=android.os.Process.myUid();
        AttributionSource attribution=context.getAttributionSource();
        check(attribution.getUid()==uid&&attribution.getPid()==pid&&attribution.getPackageName().equals(context.getPackageName()));
        Context tagged=context.createAttributionContext("owned.feature");check(tagged.getAttributionTag().equals("owned.feature")&&tagged.getAttributionSource().getAttributionTag().equals("owned.feature"));
        check(new ContextWrapper(tagged).getAttributionSource()==tagged.getAttributionSource());
        check(attribution.withNextAttributionSource(tagged.getAttributionSource()).getNext().getAttributionTag().equals("owned.feature")&&attribution.getNext()==null);
        check(context.checkPermission("owned.UNGRANTED",pid,uid)==-1&&context.checkCallingPermission("owned.UNGRANTED")==-1);
        try{context.enforceCallingOrSelfPermission("owned.UNGRANTED","denied");throw new AssertionError();}catch(SecurityException expected){}
        ActivityManager manager=context.getSystemService(ActivityManager.class);HostActivityManager.hostClearExitHistory();check(manager.getHistoricalProcessExitReasons(null,0,0).isEmpty());
        HostActivityManager.hostExitHistory("[{\"pid\":123,\"uid\":501,\"processName\":\"owned.history\",\"timestamp\":1000,\"reason\":1,\"status\":7},{\"pid\":124,\"uid\":501,\"processName\":\"owned.history:worker\",\"timestamp\":2000,\"reason\":2,\"status\":7}]");
        try{
            var history=manager.getHistoricalProcessExitReasons(null,0,0);check(history.size()==2&&history.get(0).getPid()==124);
            check(history.get(0).getStatus()==7&&history.get(0).getReason()==ApplicationExitInfo.REASON_SIGNALED);
            history.clear();check(manager.getHistoricalProcessExitReasons(context.getPackageName(),0,1).size()==1);
            var one=manager.getHistoricalProcessExitReasons(null,123,0).get(0);check(one.getStatus()==7&&one.getReason()==ApplicationExitInfo.REASON_EXIT_SELF&&one.getTimestamp()==1000);
            check(manager.getHistoricalProcessExitReasons(null,999,0).isEmpty());
            try{manager.getHistoricalProcessExitReasons("other.app",0,0);throw new AssertionError();}catch(SecurityException expected){}
            Parcel parcel=Parcel.obtain();try{one.writeToParcel(parcel,0);parcel.setDataPosition(0);var copy=ApplicationExitInfo.CREATOR.createFromParcel(parcel);check(copy.getPid()==one.getPid()&&copy.getProcessName().equals(one.getProcessName())&&copy.getRealUid()==501);}finally{parcel.recycle();}
            check(!ActivityManager.isLowMemoryKillReportSupported());
        }finally{HostActivityManager.hostClearExitHistory();}
    }
}
