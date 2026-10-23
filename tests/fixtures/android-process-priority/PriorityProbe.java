import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
public final class PriorityProbe {
 static native int tid();
 static native int port();
 static native int references(int port);
 static native int importance(int port);
 static native int qosTier(int port);
 static native int basePriority(int port);
 static native void set(int tid,int value);
 static native int get(int tid);
 static native int scheduler(int tid);
 static native void scheduler(int tid,int policy,int value);
 static native void canBackground(boolean allowed);
 static native void signal(int tid);
 static native void schedulerFamily(int tid);
 static native int libcSet(int tid,int value);
 static native int libcGet(int tid);
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static void selfPriorities(){
  int port=port();
  for(int value:new int[]{19,10,5,0,-4,-16,-20}){
   set(0,value);
   check(get(0)==value&&importance(port)==-value,"self nice retains exact CPU precedence");
   check(qosTier(port)==0,"CPU nice does not install Darwin QoS I/O throttling");
  }
  set(0,19);int low=basePriority(port);
  set(0,-20);int high=basePriority(port);
  check(high>low,"kernel CPU base priority changes with nice");
  set(0,0);
 }
 public static void main(String[] args)throws Exception{
  System.load(args[0]);
  var ready=new CountDownLatch(1);var release=new CountDownLatch(1);var assigned=new AtomicInteger();var workerPort=new AtomicInteger();var failure=new AtomicReference<Throwable>();
  Thread worker=new Thread(()->{try{assigned.set(tid());workerPort.set(port());selfPriorities();canBackground(false);ready.countDown();release.await();check(get(0)==5,"worker sees actual cross-thread priority");set(0,10);check(get(0)==10&&importance(workerPort.get())==-10,"original disabled diagnostic guard permits ServiceThread background priority");check(qosTier(workerPort.get())==0,"original background nice does not throttle Darwin I/O");canBackground(true);set(0,-4);check(get(0)==-4,"self CPU priority can be restored after cross-thread change");}catch(Throwable t){failure.set(t);ready.countDown();}},"owned-priority-worker");
  worker.start();check(ready.await(5,TimeUnit.SECONDS),"worker started");
  try{
   int target=assigned.get();check(target>0&&target!=tid(),"different live Android TID");check(target<(1<<22)&&tid()<(1<<22),"Linux PID namespace range, not Darwin kernel counter");check(tid()==tid(),"stable current identity");int refs=references(workerPort.get());
   for(int i=0;i<50;i++)for(int value:new int[]{19,10,5,0,-4,-16,-20}){
    if(i%2==0)set(target,value);else check(libcSet(target,value)==0,"guest libc resolves canonical Android TID");
    check(get(target)==value&&libcGet(target)==value,"Java and guest libc share kernel scheduling state");check(importance(workerPort.get())==-value,"actual Mach precedence changed");
    check(qosTier(workerPort.get())==0,"cross-thread nice uses the same CPU policy");
   }
   check(libcSet(target,100)==0&&get(target)==19,"Linux nice request clamps high value");
   check(libcSet(target,-100)==0&&get(target)==-20,"Linux nice request clamps low value");
   check(references(workerPort.get())==refs,"no task-thread send right accumulation");
   check(scheduler(target)==0,"original timeshare scheduler query");scheduler(target,0,0);check(scheduler(target)==0,"owned-thread scheduler update");
   schedulerFamily(target);signal(target);set(target,5);
   for(int invalid:new int[]{-21,20})try{set(target,invalid);throw new AssertionError("invalid priority accepted");}catch(IllegalArgumentException expected){}
   for(int invalid:new int[]{-1,Integer.MAX_VALUE})try{set(invalid,0);throw new AssertionError("unowned TID accepted");}catch(IllegalArgumentException expected){}
  }finally{release.countDown();worker.join(5000);}
  check(!worker.isAlive(),"worker exited");if(failure.get()!=null)throw new AssertionError(failure.get());
  // Thread.join observes Java termination before the VM's native thread teardown
  // necessarily completes. Require the kernel owner to disappear within a bound.
  long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);boolean retired=false;
  do{try{set(assigned.get(),0);Thread.sleep(1);}catch(IllegalArgumentException expected){retired=true;}}while(!retired&&System.nanoTime()<deadline);
  check(retired,"native thread retired");
  check(libcSet(assigned.get(),0)==3,"retired Android TID cannot target a host process");
  var ids=ConcurrentHashMap.<Integer>newKeySet();
  var churn=new Thread[96];
  for(int i=0;i<churn.length;i++)churn[i]=new Thread(()->{
   try{int id=tid();check(id>0&&id<(1<<22),"thread namespace range");check(id==tid(),"TLS identity stable");check(ids.add(id),"live identity unique");signal(id);}
   catch(Throwable error){failure.compareAndSet(null,error);}
  });
  for(var thread:churn)thread.start();for(var thread:churn)thread.join();
  if(failure.get()!=null)throw new AssertionError(failure.get());
  deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);
  do{ids.removeIf(id->{try{signal(id);return false;}catch(IllegalArgumentException expected){return true;}});if(!ids.isEmpty())Thread.sleep(1);}while(!ids.isEmpty()&&System.nanoTime()<deadline);
  check(ids.isEmpty(),"all churned thread identities retired");
  System.out.println("PASS owned-thread Mach priority, CPU-only nice, scheduler, signal, original background semantics and bounded port lifetime");
 }
}
