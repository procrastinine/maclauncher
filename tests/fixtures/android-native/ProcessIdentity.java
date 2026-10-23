package maclauncher.android.tests;
import android.os.Process;
public final class ProcessIdentity {
 static int checks;static void check(boolean value,String label){checks++;if(!value)throw new AssertionError(label);}
 public static void main(String[] args)throws Exception{
  check(Process.myPid()>0&&Process.myPid()==android.system.Os.getpid(),"Shared Android process identity");check(Process.myUid()>=0&&Process.myUid()==android.system.Os.getuid()&&Process.is64Bit(),"Shared Android user identity and width");int owner=Process.myTid();
  var failure=new java.util.concurrent.atomic.AtomicReference<Throwable>();
  Thread thread=new Thread(()->{try{check(Process.myTid()!=owner,"Kernel thread identity differs");for(int i=0;i<100;i++)for(int p:new int[]{10,5,0,-4,-16}){Process.setThreadPriority(p);check(Process.getThreadPriority(Process.myTid())==p,"Actual QoS query matches translated class");}Process.setThreadPriority(owner,0);check(Process.getThreadPriority(owner)==0,"Owned cross-thread scheduling reaches native policy");}catch(Throwable error){failure.set(error);}});
  thread.start();thread.join();if(failure.get()!=null)throw new AssertionError(failure.get());
  for(int p:new int[]{-21,20,Integer.MIN_VALUE,Integer.MAX_VALUE})try{Process.setThreadPriority(p);throw new AssertionError("Invalid priority");}catch(IllegalArgumentException expected){check(true,"Priority bound");}
  System.out.println("PASS actual process/thread identity and owned-thread scheduling: "+checks+" checks");
 }
}
