package maclauncher.android;

import android.app.*;
import android.content.*;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.os.Looper;
import maclauncher.android.framework.*;

/** Original component callbacks and Activity transactions after committed resize. */
public final class ConfigurationChangeProbe {
    private static void check(boolean value,String text){if(!value)throw new AssertionError(text);}
    private static String state(Activity activity)throws Exception{
        var current=Activity.class.getDeclaredField("mCurrentConfig");current.setAccessible(true);
        var owner=HostActivity.owner(activity);var record=HostActivity.class.getDeclaredField("record");record.setAccessible(true);
        var original=(ActivityThread.ActivityClientRecord)record.get(owner);
        var override=ActivityThread.ActivityClientRecord.class.getDeclaredField("overrideConfig");override.setAccessible(true);
        var created=HostActivity.class.getDeclaredField("created");created.setAccessible(true);
        var closed=HostActivity.class.getDeclaredField("closed");closed.setAccessible(true);var closing=HostActivity.class.getDeclaredField("closing");closing.setAccessible(true);
        return " config="+current.get(activity)+" override="+override.get(original)+" created="+created.get(owner)+" closed="+closed.get(owner)+" closing="+closing.get(owner)+" lifecycle="+original.getLifecycleState()+" originalRecord="+(ActivityThread.currentActivityThread().getActivity(activity.getActivityToken())==activity);
    }
    private static void publish(int width,int height,float density){
        HostWindowProbe.outputWidth=width;HostWindowProbe.outputHeight=height;
        HostSurfaceControl.resizeRoot(HostWindowProbe.fixtureOutput,width,height);
        HostDisplay.hostPublish(1,width,height,60,density);HostWindowManager.resizeOutput(width,height);
    }
    public static void run(Activity original,Looper loop)throws Exception{
        var activity=(HostWindowProbe.OwnedActivity)original;
        var field=Activity.class.getDeclaredField("mActivityInfo");field.setAccessible(true);
        var info=(ActivityInfo)field.get(activity);
        info.configChanges|=ActivityInfo.CONFIG_ORIENTATION|ActivityInfo.CONFIG_SCREEN_SIZE|ActivityInfo.CONFIG_SMALLEST_SCREEN_SIZE|ActivityInfo.CONFIG_SCREEN_LAYOUT|ActivityInfo.CONFIG_DENSITY;
        int[] applicationCallbacks={0};Configuration[] latest={null};
        var listener=new ComponentCallbacks(){public void onConfigurationChanged(Configuration config){applicationCallbacks[0]++;latest[0]=new Configuration(config);}public void onLowMemory(){}};
        activity.getApplication().registerComponentCallbacks(listener);
        try{
            var sceneField=HostSurfaceControl.class.getDeclaredField("scene");sceneField.setAccessible(true);Object scene=sceneField.get(null);
            int[] completions={0},commits={0};long[] latch={0};long beforeCompletion=System.nanoTime();
            try(var source=new android.view.SurfaceControl.Transaction();var merged=new android.view.SurfaceControl.Transaction()){
                source.setAlpha(HostWindowProbe.fixtureOutput,1).addTransactionCommittedListener(Runnable::run,()->commits[0]++).addTransactionCompletedListener(Runnable::run,stats->{
                    check(!Thread.holdsLock(scene),"original completion executor runs outside compositor metadata lock");
                    latch[0]=stats.getLatchTimeNanos();completions[0]++;
                    try(var fence=stats.getPresentFence()){check(!fence.isValid(),"synchronous offscreen output exports the original empty present fence");}
                });
                merged.merge(source);source.apply();check(commits[0]==0&&completions[0]==0,"merge transfers original transaction listeners");
                merged.apply();check(commits[0]==1&&completions[0]==0,"commit is distinct from completed output consumption");
                HostWindowProbe.pump(loop);check(completions[0]==1&&latch[0]>=beforeCompletion&&latch[0]<=System.nanoTime(),"original TransactionStats receives actual synchronous output latch time");
                merged.apply();HostWindowProbe.pump(loop);check(completions[0]==1,"reapplying a transaction does not repeat completed listeners");
                source.addTransactionCompletedListener(Runnable::run,stats->{throw new AssertionError("cleared transaction completed");});source.clear();source.apply();HostWindowProbe.pump(loop);
            }
            int before=activity.configurationChanges;
            publish(800,400,1);publish(900,400,1);
            check(applicationCallbacks[0]==0,"native publication does not reenter Application callbacks");
            HostWindowProbe.pump(loop);
            check(applicationCallbacks[0]==1&&latest[0].screenWidthDp==900,"original Application callback receives the latest coalesced configuration: callbacks="+applicationCallbacks[0]+" latest="+latest[0]);
            check(activity.configurationChanges==before+1&&activity.lastConfiguration.screenWidthDp==900,"manifest-handled resize uses original Activity configuration callback once: before="+before+" after="+activity.configurationChanges+" last="+activity.lastConfiguration+state(activity));
            check(activity.getResources().getConfiguration().screenWidthDp==900,"resources precede configuration callbacks");
            publish(900,400,1);HostWindowProbe.pump(loop);
            check(applicationCallbacks[0]==1&&activity.configurationChanges==before+1,"unchanged committed observations do not repeat callbacks");
            publish(900,400,2);HostWindowProbe.pump(loop);
            check(applicationCallbacks[0]==2&&activity.lastConfiguration.screenWidthDp==450&&activity.lastConfiguration.densityDpi==320,"density and pixels produce the original dp configuration");
            activity.startActivity(new Intent(activity,HostWindowProbe.NextActivity.class));HostWindowProbe.pump(loop);
            var previous=HostWindowProbe.NextActivity.instance;int creations=HostWindowProbe.NextActivity.creations;
            check(previous!=null,"original task launched its next Activity");
            var owner=HostActivity.owner(previous);
            publish(600,900,1);HostWindowProbe.pump(loop);
            var replacement=HostWindowProbe.NextActivity.instance;
            check(replacement!=previous&&HostWindowProbe.NextActivity.creations==creations+1,"unhandled orientation resize relaunches through original ActivityThread");
            check(HostActivity.owner(replacement)==owner,"relaunch preserves the host task and physical output owner");
            check(HostWindowProbe.NextActivity.lifecycle.contains("destroy")&&HostWindowProbe.NextActivity.lifecycle.getLast().equals("resume"),"original relaunch retires the old instance and returns to the same lifecycle state");
            check(replacement.getResources().getConfiguration().orientation==Configuration.ORIENTATION_PORTRAIT,"replacement Activity has committed portrait resources");
            replacement.finish();HostLooper.drain(loop);
            check(!activity.isDestroyed(),"another Activity's resize relaunch retains its predecessor");
            // The launcher's initial Activity starts with its existing raw
            // record too; it must enter the same original relaunch path.
            info.configChanges=0;var firstOwner=HostActivity.owner(activity);var token=activity.getActivityToken();
            publish(900,400,1);HostWindowProbe.pump(loop);
            var relaunched=ActivityThread.currentActivityThread().getActivity(token);
            check(relaunched!=activity&&activity.isDestroyed()&&relaunched instanceof HostWindowProbe.OwnedActivity,"the initial native Activity uses the same original relaunch lifecycle");
            check(HostActivity.owner(relaunched)==firstOwner,"initial relaunch preserves the one physical task owner");
            relaunched.startActivity(new Intent(relaunched,HostWindowProbe.NextActivity.class));HostWindowProbe.pump(loop);
            var child=HostWindowProbe.NextActivity.instance;
            check(child!=replacement&&!child.isDestroyed(),"navigation after initial relaunch retains the current child");
            var childView=child.getWindow().getDecorView();var parentView=relaunched.getWindow().getDecorView();
            int destroys=java.util.Collections.frequency(HostWindowProbe.NextActivity.lifecycle,"destroy");
            firstOwner.finish();HostWindowProbe.pump(loop);
            check(relaunched.isDestroyed()&&child.isDestroyed(),"retained task owner destroys both replacement and child Activities");
            check(!parentView.isAttachedToWindow()&&!childView.isAttachedToWindow(),"task retirement detaches every original ViewRoot");
            check(ActivityThread.currentActivityThread().getActivity(token)==null&&ActivityThread.currentActivityThread().getActivity(child.getActivityToken())==null,"task retirement removes original ActivityThread records");
            check(relaunched.getSystemService(ActivityManager.class).getAppTasks().isEmpty(),"task retirement removes the current task capability");
            firstOwner.finish();HostWindowProbe.pump(loop);
            check(java.util.Collections.frequency(HostWindowProbe.NextActivity.lifecycle,"destroy")==destroys+1,"repeated owner retirement does not repeat child lifecycle callbacks");
            System.out.println("PASS original configuration callbacks, coalesced resize, manifest policy and Activity relaunch ownership");
        }finally{activity.getApplication().unregisterComponentCallbacks(listener);}
    }
}
