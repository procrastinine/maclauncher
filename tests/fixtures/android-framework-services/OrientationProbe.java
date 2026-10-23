package maclauncher.android;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.os.Looper;
import maclauncher.android.bridge.WindowSession;
import maclauncher.android.framework.HostWindowManager;

/** Original task navigation with a native output recorder, without a desktop window. */
public final class OrientationProbe {
    private static native void install();
    private static native int requests();
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void run(Activity activity,Looper loop)throws Exception{
        if(Boolean.getBoolean("android.fixture.orientation.callback")){
            int[] calls={0};HostWindowManager.detachPresentation();
            HostWindowManager.attachOutput(activity,HostWindowProbe.fixtureOutput,320,240,(owner,landscape)->{check(owner==activity,"physical request belongs to the returned current Activity");calls[0]++;});
            verify(activity,loop,()->calls[0]);
            System.out.println("PASS shared physical orientation output without a JVM window session");return;
        }
        System.load(System.getProperty("orientation.probe"));install();
        try(var output=WindowSession.open("Orientation fixture",320,240)){
            output.attachActivity(activity);
            verify(activity,loop,OrientationProbe::requests);
            output.stopCallbacks(()->{});
        }
        System.out.println("PASS original Activity orientation ownership, coalescing, return and retirement");
    }
    private static void verify(Activity activity,Looper loop,java.util.function.IntSupplier requests)throws Exception{
            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
            HostWindowProbe.pump(loop);
            check(requests.getAsInt()==0,"queued requests use the latest value, not a captured older value");
            // Navigation is queued first. The following request still belongs
            // to the previous Activity when its callback eventually runs.
            activity.startActivity(new Intent(activity,HostWindowProbe.NextActivity.class));
            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
            HostWindowProbe.pump(loop);
            var next=HostWindowProbe.NextActivity.instance;
            check(next!=null&&!next.isDestroyed(),"original ActivityThread completed navigation");
            check(requests.getAsInt()==0,"a queued background request cannot resize the current owner");
            check(activity.getRequestedOrientation()==ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,"background request remains in the original Activity state");
            next.finish();HostWindowProbe.pump(loop);
            check(next.isDestroyed()&&requests.getAsInt()==1,"return applies the restored owner's retained request once");
            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
            activity.finish();HostWindowProbe.pump(loop);
            check(activity.isDestroyed()&&requests.getAsInt()==1,"retirement cancels queued output work");
    }
}
