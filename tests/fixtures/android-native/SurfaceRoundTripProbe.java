import android.graphics.*;
import android.view.*;
import java.nio.file.*;
import java.nio.file.Path;
import java.util.*;
import maclauncher.android.framework.*;
import maclauncher.android.bridge.NativeSurface;

public final class SurfaceRoundTripProbe {
    static native void prepare();
    static native Surface roundTrip(long window);
    static native void acquire(long window);
    static native void releaseWorker(long window);
    static native void releasePending(long window,Throwable failure);
    static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
    static void exercise(boolean pending){
        int[] pixel={0};var root=HostSurfaceControl.rootSurfaceControl("roundtrip",4,3,new HostSurface.Target(){
            public boolean submit(int[] pixels,int width,int height,long frame,long time){pixel[0]=pixels[0];return true;}
            public void resize(int width,int height){}
        });
        var control=new SurfaceControl.Builder().setName("original consumer").setParent(root).setBufferSize(4,3).setHidden(false).build();
        var original=new Surface(control);long lease=HostSurface.nativeLease(original),window=NativeSurface.acquire(original);check(window!=0,"native window acquisition");
        var copy=roundTrip(window);check(copy!=original&&copy.isValid()&&HostSurface.nativeLease(copy)==lease,"another original Surface retains the same consumer");
        original.release();copy.release();control.release();check(NativeSurface.valid(lease),"native reference survives every earlier Java Surface wrapper");
        copy=roundTrip(window);check(copy.isValid()&&HostSurface.nativeLease(copy)==lease,"Surface recreated from retained native window");
        Canvas canvas=copy.lockCanvas(null);canvas.drawColor(0xff2481d7);copy.unlockCanvasAndPost(canvas);check(pixel[0]==0xff2481d7,"roundtrip preserves actual original Canvas consumer");
        acquire(window);NativeSurface.releaseWindow(window);copy.release();check(NativeSurface.valid(lease),"independent native acquire retains original buffer");
        if(pending){var failure=new IllegalArgumentException("original pending exception");try{releasePending(window,failure);throw new AssertionError("pending exception lost");}catch(IllegalArgumentException actual){check(actual==failure,"retirement preserves pending exception identity");}}
        else releaseWorker(window);
        check(!NativeSurface.valid(lease),"last native release retires buffer and Java consumer exactly once");root.release();
        check(NativeSurface.statistics()[0]==0,"no native window or consumer accumulates");
    }
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),data=Files.createDirectories(Path.of(args[1]));
        HostFilesystem.configure(runtime,data,Files.createDirectories(data.resolve("files")),Files.createDirectories(data.resolve("cache")),"owned.surface.roundtrip");
        System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(runtime.resolve("native/libnativebinding.dylib").toString());
        JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
        System.setProperty("klepton.graphics",args[2]);System.load(args[2]);prepare();
        check(roundTrip(0)==null,"null native window has no Java surface");exercise(false);exercise(true);
        System.out.println("PASS original ANativeWindow/Surface roundtrip, Canvas, native lifetime, worker retirement and pending exception");
    }
}
