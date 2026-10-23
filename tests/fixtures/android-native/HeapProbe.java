import android.os.Debug;
public final class HeapProbe {
 static native long[] allocationDelta(int bytes);
 static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
 public static void main(String[]args)throws Exception{
  System.load(args[0]);
  long allocated=Debug.getNativeHeapAllocatedSize(),reserved=Debug.getNativeHeapSize(),free=Debug.getNativeHeapFreeSize();check(allocated>0&&reserved>=allocated&&free>=0,"native initial statistics");
  for(int i=0;i<128;i++){long[]v=allocationDelta(1024*1024);check(v[1]-v[0]>=1024*1024,"real malloc not reflected");check(v[1]-v[2]>=1024*1024,"free not reflected");}
  Thread[]threads=new Thread[4];java.util.concurrent.atomic.AtomicReference<Throwable>failure=new java.util.concurrent.atomic.AtomicReference<>();
  for(int t=0;t<threads.length;t++){threads[t]=new Thread(()->{try{for(int i=0;i<2000;i++){check(Debug.getNativeHeapAllocatedSize()>0,"parallel native heap");check(Debug.getNativeHeapSize()>0,"parallel reserved heap");check(Debug.getNativeHeapFreeSize()>=0,"parallel free heap");}}catch(Throwable e){failure.compareAndSet(null,e);}});threads[t].start();}
  for(Thread t:threads)t.join();if(failure.get()!=null)throw new AssertionError(failure.get());
  System.out.println("PASS actual native heap statistics,128 malloc/free delta pairs,24000 parallel queries; initial allocated="+allocated+" reserved="+reserved+" free="+free);
 }
}
