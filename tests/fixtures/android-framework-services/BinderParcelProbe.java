package maclauncher.android.fixture;

import android.os.*;
import java.nio.*;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicInteger;
import maclauncher.android.framework.HostNativeHandle;
import maclauncher.android.framework.HostObjectParcel;

public final class BinderParcelProbe {
    private static void check(boolean value){if(!value)throw new AssertionError();}
    public static void main(String[] args)throws Exception{
        RuntimeFixture.initialize(args[0],args[1],args.length>2?new String[]{args[2]}:new String[0]);
        Binder binder=new Binder();
        binder.attachInterface(null,"owned.binder.fixture");
        check(Binder.getCallingPid()==android.os.Process.myPid());
        long identity=Binder.clearCallingIdentity();Binder.restoreCallingIdentity(identity);
        { Parcel first=Parcel.obtain(),appended=Parcel.obtain(); try{
            first.writeInt(73);first.writeString("native Parcel \ud83c\udf0d");
            ByteBuffer bytes=ByteBuffer.allocateDirect(first.dataSize()+8);bytes.position(4);
            first.marshall(bytes);bytes.flip().position(4);
            appended.unmarshall(bytes);appended.setDataPosition(0);
            check(appended.readInt()==73&&"native Parcel \ud83c\udf0d".equals(appended.readString()));
            first.setDataSize(0);first.setDataPosition(0);
            first.writeStrongBinder(binder);
            appended.setDataSize(0);appended.setDataPosition(0);
            appended.appendFrom(first,0,first.dataSize());first.recycle();first=null;
            appended.setDataPosition(0);check(appended.readStrongBinder()==binder);
        }finally{if(first!=null)first.recycle();appended.recycle();}}
        byte[] large=new byte[(17<<20)+3];Arrays.fill(large,(byte)0x6d);
        { Parcel parcel=Parcel.obtain();try{
            parcel.writeBlob(large);check(parcel.getOpenAshmemSize()>=large.length);
            parcel.setDataPosition(0);check(Arrays.equals(large,parcel.readBlob()));
        }finally{parcel.recycle();}}
        ParcelFileDescriptor[] pipe=ParcelFileDescriptor.createPipe();
        { Parcel parcel=Parcel.obtain();try{
            parcel.writeFileDescriptor(pipe[0].getFileDescriptor());pipe[0].close();parcel.setDataPosition(0);
            ParcelFileDescriptor transferred=parcel.readFileDescriptor();parcel.recycle();parcel=null;
            try(var out=new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]);var in=new ParcelFileDescriptor.AutoCloseInputStream(transferred)){
                out.write(new byte[]{9,8,7});check(in.read()==9&&in.read()==8&&in.read()==7);
            }
        }finally{if(parcel!=null)parcel.recycle();}}
        AtomicInteger retired=new AtomicInteger();
        long handle=HostNativeHandle.create((AutoCloseable)retired::incrementAndGet);
        Parcel owner=Parcel.obtain(),copy=Parcel.obtain();
        HostObjectParcel.writeNativeHandle(owner,handle);HostNativeHandle.release(handle);
        copy.appendFrom(owner,0,owner.dataSize());owner.recycle();check(retired.get()==0);
        copy.setDataPosition(0);long retained=HostObjectParcel.readNativeHandle(copy,AutoCloseable.class);
        copy.recycle();check(retired.get()==0);HostNativeHandle.release(retained);check(retired.get()==1);
        System.out.println("PASS original native Parcel: primitives, direct buffers, Binder identity, retained descriptors and sealed large blobs");
    }
}
