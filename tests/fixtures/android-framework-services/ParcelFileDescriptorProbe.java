import android.os.*;
import maclauncher.android.framework.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import com.sun.management.UnixOperatingSystemMXBean;
import java.lang.management.ManagementFactory;

public final class ParcelFileDescriptorProbe {
    static void check(boolean value){if(!value)throw new AssertionError();}
    interface Action{void run()throws Exception;}
    static void fails(Class<? extends Throwable> type,Action action)throws Exception {try{action.run();}catch(Throwable error){if(type.isInstance(error))return;throw new AssertionError(error);}throw new AssertionError("Expected "+type.getName());}
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]).toRealPath(),root=Path.of(args[1]).toRealPath(),path=root.resolve("descriptor-α.bin");
        HostFilesystem.configure(runtime,root,root,root,"owned.descriptors");
        System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
        System.setProperty("klepton.bridge",runtime.resolve("native/libklepton-jvm.dylib").toString());
        if(args.length>2)System.load(Path.of(args[2]).toAbsolutePath().toString());
        System.load(System.getProperty("klepton.bridge"));System.load(runtime.resolve("native/libnativebinding.dylib").toString());
        JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
        int rw=ParcelFileDescriptor.MODE_READ_WRITE|ParcelFileDescriptor.MODE_CREATE|ParcelFileDescriptor.MODE_TRUNCATE;
        try(var fd=ParcelFileDescriptor.open(path.toFile(),rw)){
            var out=new FileOutputStream(fd.getFileDescriptor());out.write(new byte[]{10,20,30});
            check(fd.getStatSize()==3);check(fd.seekTo(1)==1);
            try(var copy=fd.dup();var in=new ParcelFileDescriptor.AutoCloseInputStream(copy)){check(in.read()==20);check(fd.seekTo(0)==0);check(in.read()==10);}
            check(fd.getFd()>=0);out.write(40); // Closing dup must not close original.
        }
        try(var append=ParcelFileDescriptor.open(path.toFile(),ParcelFileDescriptor.parseMode("wa"));var out=new ParcelFileDescriptor.AutoCloseOutputStream(append)){out.write(50);}
        check(Arrays.equals(Files.readAllBytes(path),new byte[]{10,40,30,50}));
        // AOSP mode parsing is preserved; filesystem access is constrained by the private root.
        fails(FileNotFoundException.class,()->ParcelFileDescriptor.open(root.resolve("absent").toFile(),ParcelFileDescriptor.MODE_READ_ONLY));
        try(var invalid=ParcelFileDescriptor.adoptFd(-1)){check(!invalid.getFileDescriptor().valid());}
        fails(IOException.class,()->ParcelFileDescriptor.fromFd(-1));
        try(var source=ParcelFileDescriptor.open(path.toFile(),ParcelFileDescriptor.MODE_READ_ONLY)){
            int raw=source.detachFd();fails(IllegalStateException.class,source::getFd);source.close();
            try(var adopted=ParcelFileDescriptor.adoptFd(raw);var in=new ParcelFileDescriptor.AutoCloseInputStream(adopted)){check(in.read()==10);}
        }
        var pair=ParcelFileDescriptor.createPipe();
        check(pair[0].getStatSize()==-1);fails(IOException.class,()->pair[0].seekTo(0));
        try(var in=new ParcelFileDescriptor.AutoCloseInputStream(pair[0]);var out=new ParcelFileDescriptor.AutoCloseOutputStream(pair[1])){out.write(new byte[]{1,2,3});out.close();check(Arrays.equals(in.readAllBytes(),new byte[]{1,2,3}));}
        var sockets=ParcelFileDescriptor.createSocketPair();
        try(var first=sockets[0];var second=sockets[1]){new FileOutputStream(first.getFileDescriptor()).write(73);check(new FileInputStream(second.getFileDescriptor()).read()==73);}
        fails(IOException.class,ParcelFileDescriptor::createReliablePipe);
        var blocked=ParcelFileDescriptor.createPipe();
        java.util.concurrent.atomic.AtomicReference<Throwable> readFailure=new java.util.concurrent.atomic.AtomicReference<>();
        java.util.concurrent.CountDownLatch entered=new java.util.concurrent.CountDownLatch(1);
        Thread reader=new Thread(()->{entered.countDown();try{android.system.Os.read(blocked[0].getFileDescriptor(),new byte[1],0,1);}catch(Throwable error){readFailure.set(error);}},"descriptor close wakeup");reader.setDaemon(true);reader.start();entered.await();Thread.sleep(20);blocked[0].close();reader.join(1000);blocked[1].close();check(!reader.isAlive()&&readFailure.get() instanceof android.system.ErrnoException);
        // An unbound UDP channel supplies a real fd without contacting a peer.
        try(var channel=java.nio.channels.DatagramChannel.open();var copy=ParcelFileDescriptor.fromDatagramSocket(channel.socket())){check(copy.getFd()>=0);copy.close();check(channel.isOpen());}
        try(var socket=new java.net.Socket();var copy=ParcelFileDescriptor.fromSocket(socket)){check(copy.getFd()>=0);copy.close();check(!socket.isClosed());}

        try(var asset=new android.content.res.AssetFileDescriptor(ParcelFileDescriptor.open(path.toFile(),ParcelFileDescriptor.MODE_READ_ONLY),0,Files.size(path))){
            check(asset.getFileDescriptor()==asset.getParcelFileDescriptor().getFileDescriptor());
            asset.getParcelFileDescriptor().close();fails(IOException.class,asset::createInputStream);
        }
        Parcel parcel=Parcel.obtain(),copied=Parcel.obtain();
        try(var source=ParcelFileDescriptor.open(path.toFile(),ParcelFileDescriptor.MODE_READ_ONLY)){
            parcel.writeTypedObject(source,Parcelable.PARCELABLE_WRITE_RETURN_VALUE);fails(IllegalStateException.class,source::getFd);
            check(parcel.hasFileDescriptors());fails(BadParcelableException.class,parcel::marshall);
            copied.appendFrom(parcel,0,parcel.dataSize());parcel.recycle();copied.setDataPosition(0);
            try(var restored=copied.readTypedObject(ParcelFileDescriptor.CREATOR);var in=new ParcelFileDescriptor.AutoCloseInputStream(restored)){copied.recycle();check(in.read()==10);}
        }
        // A Parcel owns copies; overwrite/shrink/recycle cannot leak or close its source.
        var mx=(UnixOperatingSystemMXBean)ManagementFactory.getOperatingSystemMXBean();
        try(var source=ParcelFileDescriptor.open(path.toFile(),ParcelFileDescriptor.MODE_READ_ONLY)){
            Bundle bundle=new Bundle();bundle.putParcelable("fd",source);check(bundle.hasFileDescriptors());
            Parcel bundled=Parcel.obtain();bundled.writeBundle(bundle);bundled.setDataPosition(0);
            Bundle restored=bundled.readBundle();bundled.recycle();try(var fd=restored.getParcelable("fd",ParcelFileDescriptor.class)){check(fd.getStatSize()==4);}
            bundle.setAllowFds(false);Parcel denied=Parcel.obtain();fails(BadParcelableException.class,()->denied.writeBundle(bundle));denied.recycle();
            long initial=mx.getOpenFileDescriptorCount();
            for(int i=0;i<32;i++){
                Parcel p=Parcel.obtain();p.writeFileDescriptor(source.getFileDescriptor());p.setDataPosition(0);
                FileDescriptor raw=p.readRawFileDescriptor();p.recycle();try(var in=new FileInputStream(raw)){source.seekTo(0);check(in.read()==10);}
                p=Parcel.obtain();p.writeFileDescriptor(source.getFileDescriptor());p.setDataPosition(0);p.writeInt(7);check(!p.hasFileDescriptors());p.recycle();
                p=Parcel.obtain();p.writeFileDescriptor(source.getFileDescriptor());p.setDataSize(2);check(!p.hasFileDescriptors());p.recycle();
            }
            check(mx.getOpenFileDescriptorCount()==initial);
            Parcel p=Parcel.obtain();p.writeFileDescriptor(source.getFileDescriptor());Parcel q=Parcel.obtain();
            fails(BadParcelableException.class,()->q.appendFrom(p,1,3));p.recycle();q.recycle();
            // Repeated closing after JDK stream closure must not close a reused OS number.
            var owner=source.dup();new FileInputStream(owner.getFileDescriptor()).close();
            try(var other=ParcelFileDescriptor.open(path.toFile(),ParcelFileDescriptor.MODE_READ_ONLY)){owner.close();check(other.getStatSize()==4);}
        }
        System.out.println("PASS real descriptors, shared offsets, streams, pipes and Parcel ownership");
    }
}
