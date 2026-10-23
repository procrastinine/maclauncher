import android.os.*;
import android.view.*;
import maclauncher.android.framework.HostLooper;
import java.util.*;

/** The image's original bounded input transport, without an Activity or window. */
public final class InputChannelProbe {
 static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 public static void main(String[] args)throws Exception {
  try{run();}catch(Throwable failure){failure.printStackTrace(System.err);System.exit(1);}
 }
 static void run()throws Exception{
  Looper.prepare();Looper loop=Looper.myLooper();Handler handler=new Handler(loop);
  retirement(loop,handler);
  InputChannel[] blocked=InputChannel.openInputChannelPair("stalled-original-input");
  InputEventSender publisher=new InputEventSender(blocked[0],loop){};
  int accepted=0;
  for(;accepted<100000;accepted++){KeyEvent key=new KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_A);boolean sent=publisher.sendInputEvent(key.getSequenceNumber(),key);key.recycle();if(!sent)break;}
  check(accepted>0&&accepted<100000,"original kernel queue applies finite backpressure without a running UI Looper");
  blocked[1].dispose();KeyEvent late=new KeyEvent(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_A);
  check(!publisher.sendInputEvent(late.getSequenceNumber(),late),"peer close rejects new input without UI progress");late.recycle();publisher.dispose();blocked[0].dispose();
  InputChannel[] pair=InputChannel.openInputChannelPair("handled-original-input");int[] received={0},finished={0};
  InputEventReceiver receiver=new InputEventReceiver(pair[1],loop){@Override public void onInputEvent(InputEvent event){received[0]++;finishInputEvent(event,((KeyEvent)event).getKeyCode()==KeyEvent.KEYCODE_A);}};
  InputEventSender sender=new InputEventSender(pair[0],loop){@Override public void onInputEventFinished(int sequence,boolean handled){check(handled==(finished[0]==0),"handled and unhandled values survive original completion");if(++finished[0]==2)loop.quitSafely();}};
  for(int code:new int[]{KeyEvent.KEYCODE_A,KeyEvent.KEYCODE_B}){KeyEvent event=new KeyEvent(KeyEvent.ACTION_DOWN,code);check(sender.sendInputEvent(event.getSequenceNumber(),event),"input published");event.recycle();}
  check(finished[0]==0,"publication is not completion");handler.postDelayed(()->{throw new AssertionError("Original channel completion timed out");},3000);
  Looper.loop();check(received[0]==2&&finished[0]==2,"original receiver completes each event exactly once");
  sender.dispose();receiver.dispose();pair[0].dispose();pair[1].dispose();
  System.out.println("PASS original ART InputChannel: bounded queue "+accepted+", peer retirement without UI progress, asynchronous handled/unhandled completion");
 }
 static void retirement(Looper loop,Handler handler)throws Exception{
  List<Integer> order=new ArrayList<>();Runnable future=()->{throw new AssertionError("Future callback was consumed during retirement");};handler.postDelayed(future,60000);
  for(int iteration=0;iteration<3;iteration++){
   int value=iteration;handler.post(()->order.add(value));long start=SystemClock.uptimeMillis();
   HostLooper.drain(loop);check(SystemClock.uptimeMillis()-start<500,"ready callback drain must not enter a blocking native poll");
   check(order.size()==iteration+1&&order.get(iteration)==iteration,"ready callbacks finish before each scope releases");
  }
  check(handler.hasCallbacks(future),"retirement leaves future callbacks with their original queue owner");
  int barrier=loop.getQueue().postSyncBarrier();handler.post(()->order.add(10));Handler.createAsync(loop).post(()->order.add(20));
  HostLooper.drain(loop);check(order.equals(List.of(0,1,2,20)),"original sync barrier does not block the asynchronous retirement boundary");
  loop.getQueue().removeSyncBarrier(barrier);HostLooper.drain(loop);check(order.equals(List.of(0,1,2,20,10)),"barrier release preserves the pending original callback");
  handler.removeCallbacks(future);handler.post(()->{HostLooper.drain(loop);order.add(30);});HostLooper.drain(loop);
  check(order.getLast()==30,"nested cleanup keeps the same queue drain owner");
  handler.post(()->order.add(40));HostLooper.drain(loop);check(order.getLast()==40,"the application Looper survives scoped retirement");
  System.out.println("PASS original ART retirement queue: ready callbacks, future work, sync barrier, repeated release and surviving Looper");
 }
}
