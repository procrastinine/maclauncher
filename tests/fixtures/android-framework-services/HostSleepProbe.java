package maclauncher.android;
import android.app.*;
import android.content.*;
import android.os.Looper;
import java.util.*;
import maclauncher.android.framework.*;

/** Simulated physical events enter the same owner called by both VM transports. */
public final class HostSleepProbe {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 private static int lifecycle(Activity activity)throws Exception{var field=HostActivity.class.getDeclaredField("record");field.setAccessible(true);return ((ActivityThread.ActivityClientRecord)field.get(HostActivity.owner(activity))).getLifecycleState();}
 public static void run(Activity activity,Looper loop)throws Exception{
  HostWindowProbe.pump(loop);check(activity.hasWindowFocus()&&lifecycle(activity)==3,"original Activity starts resumed and focused");
  HostActivity.hostSleep(true);HostWindowProbe.pump(loop);
  check(HostActivity.hostSleeping()&&!activity.hasWindowFocus()&&lifecycle(activity)==4,"sleep pauses original Activity and removes focus");
  HostWindowManager.focusOutput(true);HostActivity.resume(activity);HostActivity.hostSleep(true);HostWindowProbe.pump(loop);
  check(!activity.hasWindowFocus()&&lifecycle(activity)==4,"background focus restoration and duplicate events cannot resume sleeping Activity");
  HostActivity.hostSleep(false);HostWindowProbe.pump(loop);
  check(!HostActivity.hostSleeping()&&activity.hasWindowFocus()&&lifecycle(activity)==3,"wake restores original resumed state and prior focus");
  HostWindowManager.focusOutput(false);HostActivity.hostSleep(true);HostWindowManager.focusOutput(true);HostActivity.hostSleep(false);HostWindowProbe.pump(loop);
  check(!activity.hasWindowFocus()&&lifecycle(activity)==3,"wake preserves an unfocused window despite test focus injection");
  HostWindowManager.focusOutput(true);HostActivity.hostSleep(true);
  int resumes=Collections.frequency(HostWindowProbe.NextActivity.lifecycle,"resume");
  activity.startActivity(new Intent(activity,HostWindowProbe.NextActivity.class));HostWindowProbe.pump(loop);
  var next=HostWindowProbe.NextActivity.instance;
  check(next!=null&&lifecycle(next)!=3&&!next.hasWindowFocus()&&Collections.frequency(HostWindowProbe.NextActivity.lifecycle,"resume")==resumes,"navigation during sleep creates without resuming");
  HostActivity.hostSleep(false);HostWindowProbe.pump(loop);
  check(lifecycle(next)==3&&next.hasWindowFocus()&&lifecycle(activity)!=3,"wake resumes only the current Activity");
  HostActivity.hostSleep(true);HostActivity.owner(activity).finish();HostActivity.hostSleep(false);HostWindowProbe.pump(loop);
  check(activity.isDestroyed()&&next.isDestroyed()&&activity.getSystemService(ActivityManager.class).getAppTasks().isEmpty(),"wake never revives a retired task");
  System.out.println("PASS shared host sleep, original pause/resume, preserved focus, sleeping navigation and task retirement");
 }
}
