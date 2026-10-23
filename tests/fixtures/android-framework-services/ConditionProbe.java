import android.os.ConditionVariable;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
public final class ConditionProbe {
 static int checks;static void check(boolean v){checks++;if(!v)throw new AssertionError("check "+checks);}
 static void parked(Thread thread)throws Exception{long end=System.nanoTime()+2_000_000_000L;while(thread.getState()!=Thread.State.WAITING&&thread.getState()!=Thread.State.TIMED_WAITING){if(!thread.isAlive()||System.nanoTime()>end)throw new AssertionError("Waiter not parked");Thread.sleep(1);}}
 static void interruptConsumed(Thread thread)throws Exception{long end=System.nanoTime()+2_000_000_000L;while(thread.isInterrupted()||thread.getState()!=Thread.State.WAITING){if(!thread.isAlive()||System.nanoTime()>end)throw new AssertionError("Interrupted waiter did not return to wait");Thread.sleep(1);}}
 public static void main(String[] args)throws Exception{
  var owner=maclauncher.android.fixture.RuntimeFixture.initialize(args[1],args[0]);try{
  var closed=new ConditionVariable();check(!closed.block(-1));var opened=new ConditionVariable(true);check(opened.block(-1));opened.block();check(opened.block(0));
  for(int i=0;i<20000;i++){closed.open();check(closed.block(-1));closed.open();check(closed.block(1));closed.close();check(!closed.block(-1));}
  check(!closed.block(10));check(!closed.block(Long.MAX_VALUE));
  var values=new ArrayList<Thread>();var returned=new AtomicInteger();var interrupted=new AtomicBoolean(true);var errors=new ConcurrentLinkedQueue<Throwable>();
  try{
   for(int i=0;i<8;i++){final boolean timed=i%2==0;Thread t=new Thread(()->{try{if(timed){if(!closed.block(0))throw new AssertionError("zero timeout must wait/open");}else closed.block();returned.incrementAndGet();}catch(Throwable e){errors.add(e);}},"condition-owned-"+i);values.add(t);t.start();parked(t);}
   synchronized(closed){closed.notifyAll();}Thread.sleep(10);check(returned.get()==0);for(Thread t:values)parked(t);
   values.getFirst().interrupt();interruptConsumed(values.getFirst());check(returned.get()==0);
   closed.open();for(Thread t:values){t.join(2000);check(!t.isAlive());}check(returned.get()==8&&errors.isEmpty());closed.close();
   Thread t=new Thread(()->{closed.block();interrupted.set(Thread.currentThread().isInterrupted());});values.add(t);t.start();parked(t);t.interrupt();interruptConsumed(t);closed.open();t.join(2000);check(!t.isAlive()&&!interrupted.get());
   closed.close();Thread timed=new Thread(()->{if(closed.block(40))errors.add(new AssertionError("unexpected open"));});values.add(timed);timed.start();parked(timed);timed.interrupt();timed.join(2000);check(!timed.isAlive()&&errors.isEmpty());
  }finally{closed.open();for(Thread t:values)t.join(2000);}
  for(Field f:ConditionVariable.class.getDeclaredFields())check(!Modifier.isStatic(f.getModifiers())&&f.getType()==boolean.class);
  System.out.println("PASS pinned sticky open/close,8 waiters,spurious wake,zero/negative/overflow timeout and consumed interrupts "+checks);
  }finally{maclauncher.android.framework.HostLooper.close(owner);}
 }
}
