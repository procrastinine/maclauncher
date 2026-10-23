import android.os.Looper;
import android.view.DisplayEventReceiver;
import java.lang.ref.WeakReference;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import maclauncher.android.framework.*;
import maclauncher.android.fixture.RuntimeFixture;
public final class WakeRetirementProbe {
 private static WeakReference<Object> install(AtomicBoolean armed,AtomicInteger calls,CountDownLatch entered,CountDownLatch release){
  Object owner=new byte[4096];WeakReference<Object> weak=new WeakReference<>(owner);
  HostDisplayEvents.hostSetWakeup(()->{calls.incrementAndGet();owner.hashCode();if(armed.get()){entered.countDown();try{if(!release.await(3,TimeUnit.SECONDS))throw new AssertionError("signal deadline");}catch(InterruptedException e){throw new AssertionError(e);}}});return weak;
 }
 public static void main(String[] args)throws Exception {
  Looper loop=RuntimeFixture.initialize(args[0],args[1]);DisplayEventReceiver receiver=new DisplayEventReceiver(loop){};Thread main=Thread.currentThread();
  AtomicBoolean armed=new AtomicBoolean();AtomicInteger calls=new AtomicInteger();CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);AtomicReference<Throwable> failure=new AtomicReference<>();
  WeakReference<Object> owner=install(armed,calls,entered,release);armed.set(true);
  Thread registrar=new Thread(()->{try{receiver.scheduleVsync();}catch(Throwable e){failure.set(e);}},"registration");registrar.start();
  if(!entered.await(3,TimeUnit.SECONDS))throw new AssertionError("registration did not enter signal");
  Thread controller=new Thread(()->{try{long deadline=System.nanoTime()+2_000_000_000L;while(main.getState()!=Thread.State.BLOCKED){if(System.nanoTime()>deadline)throw new AssertionError("shutdown must wait for signal");Thread.onSpinWait();}}catch(Throwable e){failure.set(e);}finally{release.countDown();}},"retirement");controller.start();
  HostDisplayEvents.hostShutdown();registrar.join(3000);controller.join(3000);
  if(registrar.isAlive()||controller.isAlive()||failure.get()!=null)throw new AssertionError("race failed",failure.get());
  int before=calls.get();receiver.scheduleVsync();receiver.dispose();HostLooper.close(loop);
  if(calls.get()!=before||before!=2)throw new AssertionError("retired native signal called");
  for(int i=0;i<20&&owner.get()!=null;i++){System.gc();Thread.sleep(5);}if(owner.get()!=null)throw new AssertionError("retired owner retained");
  System.out.println("PASS concurrent registration/shutdown: native wake retirement waits and releases captured owner");
 }
}
