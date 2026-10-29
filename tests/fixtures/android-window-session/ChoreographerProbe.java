import android.os.*;
import android.view.Choreographer;
import java.lang.ref.WeakReference;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import maclauncher.android.framework.*;
import maclauncher.android.fixture.RuntimeFixture;

/** Exercise AOSP callback algorithms; only the native display timestamp is supplied. */
public final class ChoreographerProbe {
 static int checks;static long sequence;
 static void check(boolean value,String why){checks++;if(!value)throw new AssertionError(why);}
 static long tick(){long time=System.nanoTime();HostDisplayEvents.hostDispatchFrame(++sequence,time,time+16_666_667,16_666_667,1);return time;}
 // AOSP queues doFrame at the vsync timestamp. A bounded drain stops at work
 // ready when it began, so the delivered vsync message needs one more drain.
 static void frame(Looper loop){HostLooper.drain(loop);HostLooper.drain(loop);}
 static WeakReference<Object> cancelled(Choreographer c){Object owner=new byte[4096];WeakReference<Object> weak=new WeakReference<>(owner);Choreographer.FrameCallback cb=f->owner.hashCode();c.postFrameCallback(cb);c.removeFrameCallback(cb);return weak;}
 public static void main(String[] args)throws Exception{
  Looper loop=RuntimeFixture.initialize(args[0],args[1]);HostDisplay.hostPublish(1,640,384,60);
  Choreographer c=Choreographer.getInstance();check(c==Choreographer.getInstance(),"original per-Looper instance");
  AtomicInteger wakes=new AtomicInteger();HostDisplayEvents.hostSetWakeup(wakes::incrementAndGet);
  List<Long> times=new ArrayList<>();Choreographer.FrameCallback callback=frame->{check(Thread.currentThread()==loop.getThread(),"owner Looper");check(c.getFrameTimeNanos()==frame,"original frame time query");times.add(frame);};
  c.postFrameCallback(callback);HostLooper.drain(loop);check(times.isEmpty()&&HostDisplayEvents.hostNeedsFrames(),"registration needs actual display event");
  long first=tick();frame(loop);check(times.equals(List.of(first)),"native display time reaches original doFrame");
  c.postFrameCallback(callback);c.postFrameCallback(callback);tick();frame(loop);check(times.size()==3&&times.get(1).equals(times.get(2)),"duplicate registration semantics");
  c.postFrameCallback(callback);c.removeFrameCallback(callback);tick();frame(loop);check(times.size()==3,"original cancellation");
  c.postFrameCallbackDelayed(callback,30);tick();frame(loop);check(times.size()==3,"delay cannot run early");Thread.sleep(40);HostLooper.drain(loop);check(times.size()==3,"delay still requires source pulse");tick();frame(loop);check(times.size()==4,"original delayed callback");
  List<Integer> order=new ArrayList<>();c.postFrameCallback(frame->{order.add(1);c.postFrameCallback(next->order.add(2));});tick();frame(loop);check(order.equals(List.of(1)),"reentrant post waits for next frame");tick();frame(loop);check(order.equals(List.of(1,2)),"reentrant callback delivered");
  // AOSP may retain a delayed scheduling message until its deadline. Immediate
  // cancellation must release the callback without replacing that upstream policy.
  WeakReference<?> weak=cancelled(c);for(int i=0;i<20&&weak.get()!=null;i++){System.gc();Thread.sleep(5);}check(weak.get()==null,"cancelled callback releases game reference");
  Error original=new AssertionError("original callback failure");c.postFrameCallback(frame->{throw original;});tick();try{frame(loop);throw new AssertionError("failure lost");}catch(Error failure){check(failure==original,"original callback exception survives");}
  check(!HostDisplayEvents.hostHasInFlightCallbacks(),"exception releases native callback reservation");
  int oldWakes=wakes.get();c.postFrameCallback(callback);tick();HostDisplayEvents.hostDetachSource();HostLooper.drain(loop);
  int delivered=times.size();check(!HostDisplayEvents.hostHasInFlightCallbacks(),"detached output has no queued native callback");
  HostDisplayEvents.hostSetWakeup(wakes::incrementAndGet);check(wakes.get()>oldWakes,"new output observes retained process demand");tick();frame(loop);
  check(times.size()==delivered+1&&c==Choreographer.getInstance(),"same original Choreographer survives output replacement");
  CountDownLatch ready=new CountDownLatch(1),entered=new CountDownLatch(1),release=new CountDownLatch(1);AtomicReference<Throwable> failure=new AtomicReference<>();
  Thread worker=new Thread(()->{try{Looper.prepare();Looper own=Looper.myLooper();Choreographer other=Choreographer.getInstance();check(other!=c,"independent original scheduler");other.postFrameCallback(frame->{entered.countDown();try{release.await();}catch(InterruptedException error){throw new AssertionError(error);}own.quit();});ready.countDown();Looper.loop();}catch(Throwable error){failure.set(error);}},"frame-owner");worker.start();
  AtomicInteger presented=new AtomicInteger();var request=HostDisplayEvents.class.getDeclaredMethod("requestPresentation",Runnable.class);request.setAccessible(true);
  request.invoke(null,(Runnable)()->{check(Thread.currentThread()==loop.getThread(),"presentation keeps native UI owner");presented.incrementAndGet();});
  check(ready.await(2,TimeUnit.SECONDS),"worker ready");Thread dispatcher=new Thread(()->{try{tick();}catch(Throwable error){failure.set(error);}},"native-display-dispatcher");dispatcher.start();
  check(entered.await(2,TimeUnit.SECONDS),"background display dispatcher reaches original worker Looper while UI is blocked");dispatcher.join(2000);check(!dispatcher.isAlive()&&failure.get()==null,"display publisher never invokes guest callbacks synchronously");check(HostDisplayEvents.hostHasInFlightCallbacks(),"native retirement sees executing upstream callback");
  check(presented.get()==0,"background frame delivery cannot run UI presentation");HostDisplayEvents.hostPresentFrame();check(presented.get()==1,"UI drains each presentation once");HostDisplayEvents.hostPresentFrame();check(presented.get()==1,"no accumulated presentation retry");
  HostDisplayEvents.hostShutdown();check(HostDisplayEvents.hostHasInFlightCallbacks(),"shutdown retains executing owner");release.countDown();worker.join(2000);check(!worker.isAlive()&&failure.get()==null&&!HostDisplayEvents.hostHasInFlightCallbacks(),"last callback retires before native resources");
  int before=wakes.get();tick();frame(loop);check(before==wakes.get(),"no retired wake calls");HostDisplay.hostShutdown();HostDisplay.hostRemove();HostLooper.close(loop);
  System.out.println("PASS "+checks+" Choreographer lifecycle checks");
 }
}
