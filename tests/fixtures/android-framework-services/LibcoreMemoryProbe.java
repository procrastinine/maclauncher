import java.io.*;
import java.nio.*;
import java.nio.channels.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import libcore.io.Memory;
import libcore.io.Libcore;
import maclauncher.android.framework.*;
import maclauncher.android.fixture.RuntimeFixture;

public final class LibcoreMemoryProbe {
    private static void check(boolean value,String name){if(!value)throw new AssertionError(name);}
    public static void main(String[] args)throws Exception {
        RuntimeFixture.initialize(args[0],args[1],Arrays.copyOfRange(args,2,args.length));
        ByteBuffer storage=ByteBuffer.allocateDirect(128).order(ByteOrder.nativeOrder());
        var field=sun.misc.Unsafe.class.getDeclaredField("theUnsafe");field.setAccessible(true);
        sun.misc.Unsafe unsafe=(sun.misc.Unsafe)field.get(null);
        long pointer=unsafe.getLong(storage,unsafe.objectFieldOffset(Buffer.class.getDeclaredField("address")));
        Memory.pokeByte(pointer,(byte)0x81);check(Memory.peekByte(pointer)==(byte)0x81,"byte native");
        Memory.pokeShort(pointer+1,(short)0x9234,false);check(Memory.peekShort(pointer+1,false)==(short)0x9234,"unaligned short");
        Memory.pokeInt(pointer+3,0x12345678,true);check(Memory.peekInt(pointer+3,true)==0x12345678,"unaligned swapped int");
        Memory.pokeLong(pointer+9,0x123456789abcdef0L,false);check(Memory.peekLong(pointer+9,false)==0x123456789abcdef0L,"unaligned long");
        byte[] bytes={1,2,3,4,5};Memory.pokeByteArray(pointer,bytes,1,3);byte[] read=new byte[5];Memory.peekByteArray(pointer,read,1,3);check(Arrays.equals(read,new byte[]{0,2,3,4,0}),"byte regions");
        Object[][] arrays={{"Char",new char[]{0x1234,0xabcd,0xffff},new char[3]},
            {"Short",new short[]{0x1234,(short)0xabcd,-1},new short[3]},
            {"Int",new int[]{0x12345678,-9,42},new int[3]},
            {"Long",new long[]{0x123456789abcdef0L,-9,42},new long[3]},
            {"Float",new float[]{1.25f,-9.5f,42f},new float[3]},
            {"Double",new double[]{1.25,-9.5,42},new double[3]}};
        for(Object[] row:arrays)for(boolean swap:new boolean[]{false,true}){
            Class<?> array=row[1].getClass();
            Memory.class.getMethod("poke"+row[0]+"Array",long.class,array,int.class,int.class,boolean.class).invoke(null,pointer,row[1],0,3,swap);
            Memory.class.getMethod("peek"+row[0]+"Array",long.class,array,int.class,int.class,boolean.class).invoke(null,pointer,row[2],0,3,swap);
            check(Objects.deepEquals(row[1],row[2]),row[0]+" array swap="+swap);
        }
        int[] integers={0x12345678,0x01020304};byte[] packed=new byte[8];
        Memory.unsafeBulkPut(packed,0,8,integers,0,4,true);
        check(ByteBuffer.wrap(packed).order(ByteOrder.nativeOrder()).getInt()==Integer.reverseBytes(integers[0]),"original bulk byte order");
        int[] decoded=new int[2];Memory.unsafeBulkGet(decoded,0,8,packed,0,4,true);check(Arrays.equals(decoded,integers),"bulk native family");
        byte[] moved={1,2,3,4,5};Memory.memmove(moved,1,moved,0,4);check(Arrays.equals(moved,new byte[]{1,1,2,3,4}),"overlapping same array");
        Memory.memmove(storage,2,moved,1,4);byte[] copied=new byte[4];Memory.memmove(copied,0,storage,2,4);check(Arrays.equals(copied,new byte[]{1,2,3,4}),"direct/heap native move");
        ByteBuffer heap=ByteBuffer.wrap(new byte[]{1,2,3,4});heap.position(1);ByteBuffer slice=heap.slice();
        check(HostNio.unsafeArray(slice)==heap.array()&&HostNio.unsafeArrayOffset(slice)==1,"JDK heap storage identity");
        try{HostNio.unsafeArray(slice.asReadOnlyBuffer());throw new AssertionError("read-only helper semantics");}catch(ReadOnlyBufferException expected){}
        var pair=android.system.Os.pipe2(0);
        try{
            check(Libcore.os.write(pair[1],slice)==3,"original Linux heap ByteBuffer write");
            ByteBuffer target=ByteBuffer.allocate(6);target.position(2);target.limit(5);
            check(Libcore.os.read(pair[0],target)==3&&Arrays.equals(target.array(),new byte[]{0,0,2,3,4,0}),"original Linux heap ByteBuffer read");
        }finally{android.system.Os.close(pair[0]);android.system.Os.close(pair[1]);}
        Path file=Path.of(args[1],"nio-channel.bin");
        try(FileOutputStream out=new FileOutputStream(file.toFile());FileChannel channel=HostNio.newFileChannel(out,out.getFD(),1)){
            check(HostNio.getFD(channel)==out.getFD(),"JDK descriptor owner identity");channel.write(ByteBuffer.wrap(new byte[]{7,8}));
        }
        check(Arrays.equals(Files.readAllBytes(file),new byte[]{7,8}),"original JDK file channel");
        AtomicInteger cleaned=new AtomicInteger();
        MappedByteBuffer mapped=HostMappedBuffer.create(16,pointer,null,cleaned::incrementAndGet,false);
        HostNio.freeDirectBuffer(mapped.slice());HostNio.freeDirectBuffer(mapped);check(cleaned.get()==1,"actual shared JDK cleaner exactly once");
        HostNio.freeDirectBuffer(null);HostNio.freeDirectBuffer(storage);
        System.out.println("PASS complete upstream libcore/ART Memory natives and original NIO clients on JDK owners");
    }
}
