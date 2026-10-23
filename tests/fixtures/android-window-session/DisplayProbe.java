import android.hardware.display.*;
import android.os.*;
import android.view.Display;
import java.util.*;
import java.util.concurrent.*;
import maclauncher.android.framework.*;
import maclauncher.android.fixture.RuntimeFixture;
/** Original Display/DisplayManagerGlobal clients, with committed native observations. */
public final class DisplayProbe {
 static int checks;
 static void check(boolean value,String why){checks++;if(!value)throw new AssertionError(why);}
 static void timing(Display display){
  long period=(long)(1_000_000_000d/display.getRefreshRate());
  check(display.getAppVsyncOffsetNanos()==0,"native display clock supplies the app phase");
  check(period-(display.getPresentationDeadlineNanos()-1_000_000L)-display.getAppVsyncOffsetNanos()==0,"Android deadline decodes to the shared compositor phase");
 }
 static class Listener implements DisplayManager.DisplayListener {
  final List<Integer> events=new ArrayList<>();Thread thread;
  public void onDisplayAdded(int id){events.add(1);thread=Thread.currentThread();}
  public void onDisplayChanged(int id){events.add(2);thread=Thread.currentThread();}
  public void onDisplayRemoved(int id){events.add(3);thread=Thread.currentThread();}
 }
 public static void main(String[] args)throws Exception{
  Looper loop=RuntimeFixture.initialize(args[0],args[1]);HostDisplay.install();DisplayManagerGlobal manager=DisplayManagerGlobal.getInstance();
  check(manager.getRealDisplay(0)==null,"no unbound display fabricated");HostDisplay.hostViewport(960,600,60);
  Listener listener=new Listener();manager.registerDisplayListener(listener,new Handler(loop),7L,"fixture");manager.registerDisplayListener(listener,new Handler(loop),7L,"fixture");
  check(manager.getDisplayListeners().size()==1,"original duplicate registration");HostLooper.drain(loop);check(listener.events.isEmpty(),"no synthetic added event");
  check(HostDisplay.hostPublish(42,3456,2160,120),"committed observation");HostLooper.drain(loop);check(listener.events.equals(List.of(1)),"original added callback");
  Display display=manager.getRealDisplay(0);Display.Mode first=display.getMode();check(first.getPhysicalWidth()==3456&&first.getPhysicalHeight()==2160&&first.getRefreshRate()==120,"actual committed mode");
  timing(display);
  android.util.DisplayMetrics metrics=new android.util.DisplayMetrics();display.getMetrics(metrics);check(metrics.widthPixels==3456&&metrics.heightPixels==2160,"original metrics");
  check(!HostDisplay.hostPublish(42,3456,2160,120),"unchanged observation suppressed");HostLooper.drain(loop);check(listener.events.size()==1,"no duplicate source event");
  HostDisplay.hostViewport(800,612,60);check(display.getMode().equals(first),"request cannot alter committed extent");
  HostDisplay.hostPublish(77,800,612,59.94f);HostLooper.drain(loop);check(display.getMode().getPhysicalWidth()==800&&display.getRefreshRate()==59.94f,"raw client refreshes changed mode");check(first.getPhysicalWidth()==3456,"old mode snapshot remains immutable");
  timing(display);
  HostDisplay.hostPublish(77,1600,1224,59.94f,2);HostLooper.drain(loop);display.getMetrics(metrics);
  check(metrics.widthPixels==1600&&metrics.heightPixels==1224&&metrics.densityDpi==320&&metrics.density==2,"Retina pixels and logical density agree");
  HostDisplay.metrics(metrics);check(metrics.widthPixels/metrics.density==800&&metrics.heightPixels/metrics.density==612,"resource dp size preserved on Retina");
  check(HostDisplay.hostPublish(77,1600,1224,59.94f,1),"density-only screen change is published");HostLooper.drain(loop);display.getMetrics(metrics);check(metrics.densityDpi==160,"original display clients observe density changes");
  int before=listener.events.size();HostDisplay.hostPublish(77,801,612,60);manager.unregisterDisplayListener(listener);HostLooper.drain(loop);check(listener.events.size()==before,"original unregister cancels queued callbacks");
  HandlerThread worker=new HandlerThread("display-owner");worker.start();Listener remote=new Listener();Handler handler=new Handler(worker.getLooper());manager.registerDisplayListener(remote,handler,7L,"fixture");
  HostDisplay.hostPublish(77,802,612,60);CountDownLatch drained=new CountDownLatch(1);handler.post(drained::countDown);check(drained.await(2,TimeUnit.SECONDS)&&remote.thread==worker,"original listener owner dispatch");
  manager.unregisterDisplayListener(remote);worker.quit();worker.join(2000);check(!worker.isAlive(),"callback Looper exits");
  CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);HandlerThread blocked=new HandlerThread("inflight-display");blocked.start();
  Listener active=new Listener(){public void onDisplayChanged(int id){entered.countDown();try{release.await();}catch(InterruptedException e){throw new AssertionError(e);}}};
  manager.registerDisplayListener(active,new Handler(blocked.getLooper()),7L,"fixture");HostDisplay.hostPublish(77,803,612,60);check(entered.await(2,TimeUnit.SECONDS)&&HostDisplay.hostHasInFlightCallbacks(),"executing original callback blocks native release");
  HostDisplay.hostShutdown();check(manager.getDisplayListeners().isEmpty(),"shutdown removes original delegates");check(HostDisplay.hostHasInFlightCallbacks(),"executing callback retained");release.countDown();blocked.quitSafely();blocked.join(2000);check(!blocked.isAlive()&&!HostDisplay.hostHasInFlightCallbacks(),"callback retires before storage release");
  HostDisplay.hostRemove();check(!display.isValid(),"removed native observation invalidates original display");HostLooper.close(loop);
  System.out.println("PASS "+checks+" display snapshot/listener/thread/retention checks");
 }
}
