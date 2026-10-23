import android.hardware.display.DisplayManager;
import android.hardware.display.DisplayManagerGlobal;
import android.os.*;
import android.view.Display;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import maclauncher.android.framework.*;
import maclauncher.android.fixture.RuntimeFixture;
public final class DisplayRetirementProbe {
 static native void open(boolean bad);static native boolean stop(Throwable error);static native boolean destroy(Throwable error);static native void update();static native int releases();
 static int checks;static void check(boolean v,String why){checks++;if(!v)throw new AssertionError(why);}
 static Throwable thrown(Runnable r){try{r.run();return null;}catch(Throwable e){return e;}}
 static final Error FAILURE=new Error("owned-primary");
 public static void main(String[]args)throws Exception{
  Looper main=RuntimeFixture.initialize(args[2],args[3]);System.load(System.getProperty("klepton.graphics"));System.load(args[0]);String mode=args[1];HostDisplay.install();
  if(mode.equals("partial")){Throwable error=thrown(()->open(true));check(error instanceof IllegalStateException,"original bind failure");check(stop(null),"partial callback shutdown");check(destroy(null),"partial unbind");check(releases()==1&&HostDisplay.host().isValid(),"partial cleanup restores the physical display");HostDisplay.hostShutdown();HostDisplay.hostRemove();HostLooper.close(main);System.out.println("PASS "+checks+" partial-init");return;}
  open(false);Display d=HostDisplay.host();check(d.isValid(),"bound actual snapshot");Display.Mode snapshot=d.getMode();
  if(mode.equals("inflight")){
   HandlerThread thread=new HandlerThread("real-display-callback");thread.start();CountDownLatch entered=new CountDownLatch(1),leave=new CountDownLatch(1);
   DisplayManagerGlobal m=DisplayManagerGlobal.getInstance();AtomicInteger calls=new AtomicInteger();var listener=new DisplayManager.DisplayListener(){public void onDisplayAdded(int id){}public void onDisplayRemoved(int id){calls.incrementAndGet();}public void onDisplayChanged(int id){calls.incrementAndGet();entered.countDown();try{leave.await();}catch(InterruptedException e){throw new AssertionError(e);}}};m.registerDisplayListener(listener,new Handler(thread.getLooper()),7L,"display-retirement");
   HostDisplay.hostPublish(42,640,400,120);check(entered.await(1,TimeUnit.SECONDS),"callback entered");check(!stop(null),"inflight blocks retirement");check(d.isValid(),"bound window survives stop");check(thrown(()->destroy(null)) instanceof IllegalStateException&&releases()==0,"cannot destroy inflight");leave.countDown();m.unregisterDisplayListener(listener);thread.quitSafely();thread.join(1000);check(!thread.isAlive()&&stop(null),"callback retired");check(calls.get()==1,"no added teardown callback");check(destroy(null)&&d.isValid()&&releases()==1&&!d.getMode().equals(snapshot),"output detaches only after callback+producer retirement and restores the physical display");HostDisplay.hostShutdown();HostDisplay.hostRemove();HostLooper.close(main);System.out.println("PASS "+checks+" inflight");return;
  }
  if(mode.equals("pending")){check(thrown(()->stop(FAILURE))==FAILURE,"stop preserves primary");check(d.isValid(),"pending stop retains bound snapshot");check(thrown(()->destroy(FAILURE))==FAILURE,"destroy preserves primary");check(d.isValid()&&releases()==1&&!d.getMode().equals(snapshot),"cleanup restores physical display despite pending primary");HostDisplay.hostShutdown();HostDisplay.hostRemove();HostLooper.close(main);System.out.println("PASS "+checks+" pending");return;}
  check(stop(null),"display callbacks stopped");
  {

   AtomicReference<Throwable> failure=new AtomicReference<>();Thread producer=new Thread(()->{try{for(int n=0;n<10000;n++){var m=new android.util.DisplayMetrics();d.getRealMetrics(m);if(m.widthPixels!=640||m.heightPixels!=400||!d.getMode().equals(snapshot)||d.getRefreshRate()!=119.88f)throw new AssertionError("Committed snapshot changed");}}catch(Throwable e){failure.set(e);}},"owned-native-producer");producer.start();producer.join(1000);check(!producer.isAlive(),"querying worker joined");check(failure.get()==null,"real snapshot available throughout producer join");
  }
  check(stop(null),"idempotent retirement");{check(thrown(DisplayRetirementProbe::update) instanceof IllegalStateException&&d.getMode().equals(snapshot),"new adapter writes fail after stop without snapshot loss");AtomicReference<Throwable> wrong=new AtomicReference<>();Thread thread=new Thread(()->wrong.set(thrown(HostDisplay::hostRemove)));thread.start();thread.join();check(wrong.get() instanceof IllegalStateException&&d.isValid(),"wrong-owner removal refused");}
  check(destroy(null),"destroy after producer joined");check(releases()==1&&d.isValid()&&!d.getMode().equals(snapshot),"output destruction restores the physical display");HostDisplay.hostShutdown();HostDisplay.hostRemove();check(!d.isValid(),"full display removal invalidates the original client");HostLooper.close(main);System.out.println("PASS "+checks+" "+mode);
 }
}
