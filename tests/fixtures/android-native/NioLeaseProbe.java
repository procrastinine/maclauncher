import java.nio.*;
import java.util.concurrent.atomic.AtomicReference;
import maclauncher.android.framework.HostNio;

public final class NioLeaseProbe {
    private static void denied(Runnable access){
        try{access.run();throw new AssertionError("Revoked direct-buffer access succeeded");}
        catch(IllegalStateException expected){}
    }
    public static void main(String[] arguments)throws Exception{
        ByteBuffer root=ByteBuffer.allocateDirect(128).order(ByteOrder.nativeOrder());
        HostNio.track(root);
        root.putInt(0,0x12345678);
        ByteBuffer duplicate=root.duplicate(),readOnly=root.asReadOnlyBuffer(),slice=root.slice(0,64);
        IntBuffer integers=root.asIntBuffer();LongBuffer longs=root.asLongBuffer();
        CharBuffer characters=root.asCharBuffer();DoubleBuffer doubles=root.asDoubleBuffer();
        // These aliases exist before the first accessibility change.
        for(int n=0;n<100000;n++)if(root.getInt(0)!=0x12345678)throw new AssertionError("Native bytes changed");
        HostNio.setAccessible(root,false);HostNio.setAccessible(root,false);
        if(HostNio.isAccessible(root)||HostNio.isAccessible(slice))throw new AssertionError("Shared MemoryRef stayed accessible");
        denied(()->root.get(0));denied(()->root.put(0,(byte)9));denied(()->duplicate.getInt(0));
        denied(()->readOnly.get(0));denied(()->slice.get(new byte[4]));
        denied(()->integers.get(0));denied(()->longs.put(0,7));
        denied(()->characters.get(0));denied(()->doubles.get(new double[2]));
        var failure=new AtomicReference<Throwable>();
        Thread worker=new Thread(()->{try{denied(()->root.get(0));HostNio.setAccessible(slice,true);if(root.getInt(0)!=0x12345678)throw new AssertionError("Reactivation changed native bytes");}catch(Throwable error){failure.set(error);}});
        worker.start();worker.join();if(failure.get()!=null)throw new AssertionError(failure.get());
        if(!HostNio.isAccessible(root)||!HostNio.isAccessible(readOnly)||integers.get(0)!=0x12345678)throw new AssertionError("Existing views did not reactivate");
        HostNio.setAccessible(duplicate,false);denied(()->root.getInt(0));HostNio.setAccessible(root,true);
        if(root.getInt(0)!=0x12345678||root.position()!=0||root.limit()!=128)throw new AssertionError("Buffer state changed");
        ByteBuffer heap=ByteBuffer.allocate(8);if(!HostNio.isAccessible(heap))throw new AssertionError();
        try{HostNio.setAccessible(heap,false);throw new AssertionError("Heap hidden API must retain Android's unsupported result");}catch(UnsupportedOperationException expected){}
        // A pre-existing foreign owner remains authoritative and cannot be
        // revived by an Android codec's independently mutable lease.
        Class<?> arenaType=Class.forName("java.lang.foreign.Arena"),segmentType=Class.forName("java.lang.foreign.MemorySegment");
        Object arena=arenaType.getMethod("ofShared").invoke(null);
        Object segment=arenaType.getMethod("allocate",long.class,long.class).invoke(arena,16L,8L);
        ByteBuffer independent=(ByteBuffer)segmentType.getMethod("asByteBuffer").invoke(segment);HostNio.track(independent);
        try{HostNio.setAccessible(independent,true);throw new AssertionError("Foreign memory ownership was replaced");}catch(UnsupportedOperationException expected){}
        arenaType.getMethod("close").invoke(arena);denied(()->independent.get(0));
        System.out.println("PASS original JDK NIO scope revokes and restores shared direct/typed views, keeps bytes and owners, and excludes foreign lease revival");
    }
}
