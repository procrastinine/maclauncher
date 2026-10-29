import android.os.*;import maclauncher.android.framework.*;import java.nio.file.*;import java.io.*;import java.util.*;import java.util.concurrent.*;import java.util.concurrent.atomic.*;
/** Original AOSP scheduling/barriers/dispatch with its original native queue. */
public final class NativeMessageQueueProbe {
 static native FileDescriptor[] pipe();static native void write(FileDescriptor fd);static native void read(FileDescriptor fd);static native void close(FileDescriptor fd);static native void finishInput(long queue);
 static void check(boolean value,String text){if(!value)throw new AssertionError(text);}
 static void until(Looper loop,java.util.function.BooleanSupplier done)throws Exception{long end=System.nanoTime()+2_000_000_000L;while(!done.getAsBoolean()&&System.nanoTime()<end){HostLooper.pump(loop);Thread.sleep(1);}check(done.getAsBoolean(),"queue deadline");}
 public static void main(String[] args)throws Exception{
  Path runtime=Path.of(args[0]),root=Path.of(args[1]);Files.createDirectories(root.resolve("files"));Files.createDirectories(root.resolve("cache"));
  HostFilesystem.configure(runtime,root,root.resolve("files"),root.resolve("cache"),"owned.messaging");
  System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
  System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(runtime.resolve("native/libnativebinding.dylib").toString());System.load(args[2]);
  HostProcessIdentity.initializeIds();
  JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
  HostContext.hostPackage("owned.messaging","1",1);HostContext.hostApplicationInfo(false,runtime.resolve("android-framework.jar").toString(),args[1],runtime.resolve("native").toString(),35);
  Looper loop=HostLooper.main();Handler handler=new Handler(loop);List<Integer> order=new ArrayList<>();
  handler.post(()->order.add(2));handler.postAtFrontOfQueue(()->order.add(1));Runnable removed=()->order.add(99);handler.post(removed);handler.removeCallbacks(removed);HostLooper.pump(loop);check(order.equals(List.of(1,2)),"front/order/removal");
  int barrier=loop.getQueue().postSyncBarrier();handler.post(()->order.add(4));Handler.createAsync(loop).post(()->order.add(3));HostLooper.pump(loop);check(order.equals(List.of(1,2,3)),"sync barrier");loop.getQueue().removeSyncBarrier(barrier);HostLooper.pump(loop);check(order.equals(List.of(1,2,3,4)),"barrier removal");
  var configure=Class.forName("maclauncher.android.bridge.NativeBinding").getDeclaredMethod("configureRuntime",byte[].class,byte[].class);configure.setAccessible(true);
  configure.invoke(null,runtime.resolve("native/libklepton-jvm.dylib").toRealPath().toString().getBytes(java.nio.charset.StandardCharsets.UTF_8),runtime.resolve("native").toRealPath().toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
  android.view.InputQueue input=new android.view.InputQueue();AtomicInteger inputFinished=new AtomicInteger();
  android.view.KeyEvent key=new android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN,android.view.KeyEvent.KEYCODE_A);Object inputToken=new Object();
  try{
   input.sendInputEvent(key,inputToken,false,(token,handled)->{check(token==inputToken&&handled,"original native input completion payload");inputFinished.incrementAndGet();});
   barrier=loop.getQueue().postSyncBarrier();
   try{finishInput(input.getNativePtr());HostLooper.pump(loop);check(inputFinished.get()==1,"native input completion bypasses a pending traversal barrier");}
   finally{loop.getQueue().removeSyncBarrier(barrier);}
  }finally{input.dispose();key.recycle();}
  AtomicInteger idle=new AtomicInteger();loop.getQueue().addIdleHandler(()->{idle.incrementAndGet();return false;});HostLooper.pump(loop);check(idle.get()==1,"idle handler");
  long start=SystemClock.uptimeMillis();AtomicLong fired=new AtomicLong();handler.postDelayed(()->fired.set(SystemClock.uptimeMillis()),30);HostLooper.pump(loop);check(fired.get()==0,"real delay");until(loop,()->fired.get()!=0);check(fired.get()-start>=30,"monotonic deadline");
  AtomicInteger animation=new AtomicInteger();List<String> turns=new ArrayList<>();
  Runnable animated=new Runnable(){public void run(){int count=animation.incrementAndGet();java.util.concurrent.locks.LockSupport.parkNanos(2_000_000L);if(count<80)handler.post(this);}};
  handler.post(animated);HostLooper.pump(loop);int firstTurn=animation.get();
  check(firstTurn>0&&firstTurn<80,"Continuous original Handler work must yield before exhausting its animation");
  check(HostLooper.waitMillis(1000)==0,"Deferred ready messages must resume without an idle native wait");
  turns.add("native-input-and-presentation");handler.post(()->turns.add("android-input"));
  until(loop,()->turns.size()==2);check(turns.equals(List.of("native-input-and-presentation","android-input")),"Native input/presentation can run between original queue turns");
  until(loop,()->animation.get()==80);HostLooper.pump(loop);check(HostLooper.waitMillis(1000)>0,"An idle queue must not retain the bounded-turn wake");
  System.out.println("PASS bounded physical window turn: "+firstTurn+" callbacks, deferred work resumes, original order and idle wait retained");
  AtomicInteger messages=new AtomicInteger();new Messenger(new Handler(loop){public void handleMessage(Message m){messages.set(m.what);}}).send(Message.obtain(null,7));HostLooper.pump(loop);check(messages.get()==7,"raw Messenger local endpoint");
  Object token=new String("token"),equalToken=new String("token");AtomicInteger selected=new AtomicInteger();Runnable selection=selected::incrementAndGet;
  handler.postAtTime(selection,token,SystemClock.uptimeMillis());handler.postAtTime(selection,equalToken,SystemClock.uptimeMillis());handler.removeCallbacks(selection,token);HostLooper.pump(loop);check(selected.get()==1,"original cancellation uses token identity");
  Message original=Message.obtain(handler,10,11,12,"payload");original.getData().putString("data","original");Message copy=Message.obtain(original);copy.getData().putString("data","copy");check(original.getData().getString("data").equals("original"),"original Message copy isolates Bundle");copy.recycle();original.recycle();
  AtomicInteger replies=new AtomicInteger();Messenger reply=new Messenger(new Handler(loop,m->{check(m.what==42,"reply value");replies.incrementAndGet();return true;}));
  Handler recipient=new Handler(loop,m->{check(m.sendingUid==android.os.Process.myUid()&&m.arg1==3&&m.arg2==5&&m.getData().getString("payload").equals("kept"),"original Messenger payload and real calling UID");try{m.replyTo.send(Message.obtain(null,42));}catch(RemoteException error){throw new AssertionError(error);}return true;});
  Messenger endpoint=new Messenger(recipient),same=new Messenger(endpoint.getBinder());check(endpoint.equals(same),"original binder endpoint identity");
  Message delivery=Message.obtain(null,1,3,5);delivery.replyTo=reply;delivery.getData().putString("payload","kept");same.send(delivery);check(replies.get()==0,"no inline Messenger callbacks");HostLooper.pump(loop);check(replies.get()==1,"original reply dispatch");
  Parcel parcel=Parcel.obtain();endpoint.writeToParcel(parcel,0);parcel.setDataPosition(0);check(Messenger.CREATOR.createFromParcel(parcel).equals(endpoint),"actual native Parcel preserves Binder identity");parcel.recycle();
  check(delivery.replyTo==null&&delivery.obj==null&&delivery.getTarget()==null,"original recycling drops payload and reply owners");
  FileDescriptor[] descriptors=pipe();AtomicInteger reads=new AtomicInteger(),writes=new AtomicInteger();
  try{
   loop.getQueue().addOnFileDescriptorEventListener(descriptors[0],1,(fd,events)->{check((events&1)!=0,"native input flags");read(fd);reads.incrementAndGet();return 0;});
   write(descriptors[1]);until(loop,()->reads.get()==1);write(descriptors[1]);HostLooper.pump(loop);check(reads.get()==1,"callback return removes listener");read(descriptors[0]);
   loop.getQueue().addOnFileDescriptorEventListener(descriptors[1],2,(fd,events)->{check((events&2)!=0,"native output flags");writes.incrementAndGet();return 0;});until(loop,()->writes.get()==1);
   loop.getQueue().addOnFileDescriptorEventListener(descriptors[0],1,(fd,events)->{read(fd);reads.incrementAndGet();loop.getQueue().removeOnFileDescriptorEventListener(fd);loop.getQueue().addOnFileDescriptorEventListener(fd,1,(again,bits)->{read(again);reads.incrementAndGet();return 0;});return 0;});
   write(descriptors[1]);until(loop,()->reads.get()==2);write(descriptors[1]);until(loop,()->reads.get()==3);
   AtomicInteger hangup=new AtomicInteger();loop.getQueue().addOnFileDescriptorEventListener(descriptors[0],4,(fd,events)->{check((events&4)!=0,"native hangup maps to error");hangup.incrementAndGet();return 0;});close(descriptors[1]);until(loop,()->hangup.get()==1);
  }finally{loop.getQueue().removeOnFileDescriptorEventListener(descriptors[0]);close(descriptors[0]);close(descriptors[1]);}
  HandlerThread worker=new HandlerThread("owned-message-worker");worker.start();Looper other=worker.getLooper();AtomicInteger retired=new AtomicInteger();CountDownLatch done=new CountDownLatch(1);check(HostLooper.addShutdownListener(other,retired::incrementAndGet),"worker resource owner");Handler workerHandler=new Handler(other);workerHandler.post(()->{check(Thread.currentThread()==worker,"owner dispatch");done.countDown();});check(done.await(2,TimeUnit.SECONDS),"worker wake");workerHandler.postDelayed(()->{throw new AssertionError("future callback after quit");},10_000);worker.quitSafely();worker.join(2000);check(!worker.isAlive()&&retired.get()==1,"quit safely and retirement");
  AtomicInteger stopped=new AtomicInteger();HostLooper.addShutdownListener(loop,stopped::incrementAndGet);HostLooper.close(loop);check(stopped.get()==1&&!handler.post(()->{}),"main close revokes scheduling");HostLooper.close(loop);check(stopped.get()==1,"idempotent cleanup");
  check(!loop.getQueue().isPolling(),"retired original queue has no polling owner");
  System.out.println("PASS raw AOSP messages/barriers/delays/idle/Messenger, real FD input/output/hangup/reentrant registration, worker wake and retirement");
 }
}
