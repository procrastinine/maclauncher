package maclauncher.android;

import android.app.Activity;
import java.util.*;
import maclauncher.android.framework.*;
import maclauncher.android.fixture.RuntimeFixture;

/** Exercise the real shared output owner and original MessageQueue without a game. */
public final class OutputRetirementProbe {
 private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args){try{run(args);System.exit(0);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
 private static void run(String[] args)throws Exception{
  var loop=RuntimeFixture.initialize(args[0],args[1]);
  List<String> events=new ArrayList<>();
  Error primary=new AssertionError("original presentation failure"),lifecycle=new AssertionError("Activity teardown failure"),callbacks=new AssertionError("callback retirement failure"),close=new AssertionError("window close failure");
  HostActivity.Window window=new HostActivity.Window(){
   public void attachActivity(Activity activity){}
   public void present(Activity activity,String title,int width,int height){}
   public void stopCallbacks(Runnable tasks){events.add("callbacks");tasks.run();throw callbacks;}
   public void close(){events.add("close");throw close;}
  };
  new android.os.Handler(loop).post(()->events.add("owner-task"));
  Throwable result=HostActivity.closeWindow(primary,()->{events.add("lifecycle");throw lifecycle;},window);
  check(result==primary,"presentation failure remains primary");
  check(Arrays.equals(result.getSuppressed(),new Throwable[]{lifecycle,callbacks,close}),"later failures remain suppressed in retirement order");
  check(events.equals(List.of("lifecycle","callbacks","owner-task","close")),"Activity failure still drains the original owner queue and attempts window close: "+events);
  events.clear();
  Throwable[] foreign={null};Thread worker=new Thread(()->foreign[0]=HostActivity.closeWindow(null,()->events.add("lifecycle"),window),"Foreign output retirement");worker.start();worker.join();
  check(foreign[0] instanceof IllegalStateException,"original compositor refuses a foreign owner thread");
  check(events.equals(List.of("lifecycle")),"failed compositor detach retains the display callbacks and window for the active producer");
  check(foreign[0].getSuppressed().length==0,"failed compositor detach does not enter later resource retirement");
  events.clear();HostActivity.Window clean=new HostActivity.Window(){
   public void attachActivity(Activity activity){}
   public void present(Activity activity,String title,int width,int height){}
   public void stopCallbacks(Runnable tasks){events.add("callbacks");tasks.run();}
   public void close(){events.add("close");}
  };
  check(HostActivity.closeWindow(null,()->events.add("lifecycle"),clean)==null,"successful retirement returns no failure");
  check(events.equals(List.of("lifecycle","callbacks","close")),"successful retirement keeps the same order");
  HostLooper.close(loop);
  System.out.println("PASS shared output retirement: first failure, suppressed cleanup, original owner queue and compositor-before-callback barrier");
 }
}
