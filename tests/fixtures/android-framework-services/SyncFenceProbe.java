package maclauncher.android.fixture;

import android.hardware.SyncFence;
import android.os.Parcel;
import android.os.ParcelFileDescriptor;
import java.time.Duration;

/** Real original JNI, descriptor ownership and native allocation retirement. */
public final class SyncFenceProbe {
    private static void check(boolean value,String text){if(!value)throw new AssertionError(text);}
    public static void main(String[] args)throws Exception{
        RuntimeFixture.initialize(args[0],args[1],java.util.Arrays.copyOfRange(args,2,args.length));
        try(var empty=SyncFence.createEmpty()){
            check(!empty.isValid()&&empty.getSignalTime()==SyncFence.SIGNAL_TIME_INVALID,"original empty fence state");
            var parcel=Parcel.obtain();try{
                empty.writeToParcel(parcel,0);parcel.setDataPosition(0);
                try(var restored=SyncFence.CREATOR.createFromParcel(parcel)){check(!restored.isValid(),"empty Parcel roundtrip");}
            }finally{parcel.recycle();}
        }
        var invalid=SyncFence.adopt(-1);
        var retained=new SyncFence(invalid);
        check(!invalid.isValid()&&invalid.await(Duration.ZERO),"allocated invalid native fence has original immediate wait");
        invalid.close();invalid.close();
        check(!retained.isValid()&&retained.awaitForever(),"native reference survives independent wrapper retirement");
        retained.close();
        var pipe=ParcelFileDescriptor.createPipe();
        var fence=SyncFence.create(pipe[0]);
        check(fence.isValid()&&!fence.await(Duration.ZERO),"real unsignaled pollable descriptor");
        var copy=new SyncFence(fence);
        try(var fd=fence.getFdDup()){check(fd.getFd()>=0,"native descriptor duplication");}
        try(var out=new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])){
            out.write(7);out.flush();check(fence.awaitForever(),"real descriptor signal reaches original native wait");
            // A pipe supplies poll readiness, not a Linux sync-file timestamp.
            check(fence.getSignalTime()==SyncFence.SIGNAL_TIME_INVALID,"non-sync descriptor retains normal ioctl error");
            fence.close();check(copy.isValid()&&copy.awaitForever(),"native reference copy owns the same live descriptor");
        }
        copy.close();copy.close();
        check(!fence.isValid()&&!copy.isValid(),"all original wrappers retired");
        System.out.println("PASS original SyncFence: all JNI entries, empty/invalid state, descriptor wait, Parcel, native references and independent close");
    }
}
