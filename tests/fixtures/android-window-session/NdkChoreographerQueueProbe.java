import android.os.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import maclauncher.android.framework.*;
import maclauncher.android.fixture.RuntimeFixture;

/** Native callbacks must execute through the original Java queue's own poller. */
public final class NdkChoreographerQueueProbe {
 static native void configure(boolean enabled);
 static native void post();
 static native void tick(long sequence,long time);
 static HandlerThread worker;
 static final BlockingQueue<Long> frames=new LinkedBlockingQueue<>();
 static final AtomicReference<Throwable> failure=new AtomicReference<>();
 static int received;
 static void frame(long time){
  if(Thread.currentThread()!=worker)throw new AssertionError("Native callback escaped Java queue owner");
  if(++received<3)post();frames.add(time);
 }
 public static void main(String[] args)throws Exception{
  Looper main=RuntimeFixture.initialize(args[0],args[1]);System.load(args[2]);configure(true);
  worker=new HandlerThread("native-display-java-queue");worker.start();CountDownLatch ready=new CountDownLatch(1);
  try{
   new Handler(worker.getLooper()).post(()->{try{post();}catch(Throwable e){failure.set(e);}finally{ready.countDown();}});
   if(!ready.await(2,TimeUnit.SECONDS)||failure.get()!=null)throw new AssertionError("Native callback registration",failure.get());
   for(int i=1;i<=3;i++){long time=System.nanoTime();tick(i,time);Long got=frames.poll(2,TimeUnit.SECONDS);if(got==null||got!=time)throw new AssertionError("Native callback did not traverse original Java queue: "+got);}
  }finally{worker.quit();worker.join(2000);configure(false);HostLooper.close(main);}
  if(worker.isAlive())throw new AssertionError("Original Java queue did not retire");
  System.out.println("PASS native Choreographer callbacks share original Java HandlerThread ALooper, reentrant posts and queue retirement");
 }
}
