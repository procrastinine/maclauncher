package callbacks;
public final class CallbackOwner {
    private int value;
    public CallbackOwner(){}
    public CallbackOwner(int value){this.value=value;}
    public static void capture(CallbackOwner owner,int value){owner.value=value;}
    public int value(){return value;}
    public static final class Other {public int value(){return 7;}}
    private static native long createBindings();
    private static native long retainBindings(long owner);
    private static native void releaseBindings(long owner);
    private native void exercise(long owner);
    public static void main(String[] args)throws Exception{
        System.load(args[0]);long owner=createBindings();long retained=retainBindings(owner);releaseBindings(owner);
        try{
            var start=new java.util.concurrent.CountDownLatch(1);
            var failure=new java.util.concurrent.atomic.AtomicReference<Throwable>();
            Thread[] workers=new Thread[8];
            for(int i=0;i<workers.length;i++){workers[i]=new Thread(()->{try{start.await();new CallbackOwner().exercise(retained);}catch(Throwable error){failure.compareAndSet(null,error);}});workers[i].start();}
            start.countDown();for(Thread worker:workers)worker.join();if(failure.get()!=null)throw new AssertionError(failure.get());
            System.gc();new CallbackOwner().exercise(retained);
        }finally{releaseBindings(retained);}
        System.out.println("PASS typed callback concurrent lazy resolution, retained ownership and cleanup across JNI lifetimes");
    }
}
