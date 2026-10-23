import android.graphics.*;
import android.os.*;
import android.hardware.HardwareBuffer;
import android.view.*;
import java.nio.file.*;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.atomic.*;
import maclauncher.android.framework.*;
import maclauncher.android.bridge.NativeSurface;

/** Original framework clients backed by actual host buffers; display ticks are controlled inputs. */
public final class NativeSurfaceFrameworkProbe {
    static native void scenePresenter(String graphics,boolean enabled);
    static native long sceneAttach(Surface surface);
    static native void sceneDetach(long owner);
    static void check(boolean value,String label){if(!value)throw new AssertionError(label);}
    static final class Output implements HostSurface.Target {
        int[] pixels;int width,height,submitted;
        public boolean submit(int[] pixels,int width,int height,long frame,long time){this.pixels=pixels.clone();this.width=width;this.height=height;submitted++;return true;}
        public void resize(int width,int height){this.width=width;this.height=height;}
        int pixel(int x,int y){return pixels[y*width+x];}
    }
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Path.of(args[1]);Files.createDirectories(data.resolve("files"));Files.createDirectories(data.resolve("cache"));
        HostFilesystem.configure(runtime,data,data.resolve("files"),data.resolve("cache"),"owned.surface");
        System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
        System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(runtime.resolve("native/libnativebinding.dylib").toString());
        JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
        System.load(args[2]);
        Looper loop=HostLooper.main();HostDisplayEvents.hostSetWakeup(()->{});var output=new Output();
        SurfaceControl root=HostSurfaceControl.rootSurfaceControl("owned window",8,8,output);
        SurfaceSession session=new SurfaceSession();
        SurfaceControl child=new SurfaceControl.Builder(session).setName("owned canvas").setBufferSize(4,4).setParent(root).build();
        try(var transaction=new SurfaceControl.Transaction()){
            transaction.setFrameRate(child,30,Surface.FRAME_RATE_COMPATIBILITY_DEFAULT)
                .setFrameRateSelectionPriority(child,0).setFrameRateSelectionStrategy(child,0)
                .setFrameRateCategory(child,0,true).setDefaultFrameRateCompatibility(child,0)
                .setFrameTimelineVsync(0).clearFrameRate(child)
                .setDesiredHdrHeadroom(child,0).setExtendedRangeBrightness(child,1,1).setDimmingEnabled(child,true)
                .setCornerRadius(child,0).setDestinationFrame(child,4,4).show(child).setPosition(child,2,1).apply();
        }
        Surface surface=new Surface(child);
        long nativeWindow=NativeSurface.acquire(surface);check(nativeWindow!=0,"raw Surface resolves actual ANativeWindow");check(Arrays.equals(NativeSurface.geometry(nativeWindow),new int[]{4,4,1}),"actual native extent");
        // A retained producer is a stable window identity, not a resize lock.
        var resized=new BLASTBufferQueue("retained producer resize",false);resized.update(child,3,5,1);
        check(Arrays.equals(NativeSurface.geometry(nativeWindow),new int[]{3,5,1}),"retained ANativeWindow sees committed buffer geometry");
        resized.update(child,4,4,1);resized.destroy();NativeSurface.releaseWindow(nativeWindow);
        Canvas canvas=surface.lockCanvas(null);canvas.drawColor(0xffff0000);surface.unlockCanvasAndPost(canvas);
        check(output.pixel(2,1)==0xffff0000&&output.pixel(0,0)==0,"original Canvas and positioned layer composition");
        check(surface.getNextFrameNumber()==2,"actual Canvas frame acquisition");
        Bitmap copied=Bitmap.createBitmap(2,2,Bitmap.Config.ARGB_8888);AtomicInteger copyStatus=new AtomicInteger(-1);
        PixelCopy.request(surface,new Rect(1,1,3,3),copied,copyStatus::set,new Handler(loop));
        check(copyStatus.get()==-1,"original PixelCopy Handler dispatch");HostLooper.drain(loop);check(copyStatus.get()==PixelCopy.SUCCESS&&copied.getPixel(1,1)==0xffff0000,"original region overload copies the posted Canvas image");copied.recycle();
        AtomicReference<PixelCopy.Result> copyResult=new AtomicReference<>();
        var request=PixelCopy.Request.Builder.ofSurface(surface).setSourceRect(new Rect(0,0,2,3)).build();PixelCopy.request(request,Runnable::run,copyResult::set);
        check(copyResult.get().getStatus()==PixelCopy.SUCCESS&&copyResult.get().getBitmap().getWidth()==2&&copyResult.get().getBitmap().getHeight()==3,"original Request.Builder allocates the destination");copyResult.get().getBitmap().recycle();
        var queue=new BLASTBufferQueue("owned buffer queue",false);queue.update(child,4,4,1);Surface queued=queue.createSurface();AtomicInteger synced=new AtomicInteger();
        check(queue.syncNextTransaction(transaction->{try(transaction){transaction.apply();}synced.incrementAndGet();}),"next acquired frame registration");
        canvas=queued.lockCanvas(null);canvas.drawColor(0xff00ff00);queued.unlockCanvasAndPost(canvas);
        check(synced.get()==1&&queue.getLastAcquiredFrameNum()==2&&output.pixel(3,2)==0xff00ff00,"BLAST observes actual posted buffers");
        queue.destroy();queued.release();
        // Original Surface/HardwareBuffer Parcelable algorithms own these calls.
        // Closing/recycling any one wrapper must not invalidate another owner.
        Parcel parcel=Parcel.obtain(),appended=Parcel.obtain();
        surface.writeToParcel(parcel,Parcelable.PARCELABLE_WRITE_RETURN_VALUE);
        check(!surface.isValid(),"upstream return-value parcel flag releases sender");
        appended.appendFrom(parcel,0,parcel.dataSize());parcel.recycle();appended.setDataPosition(0);
        surface=Surface.CREATOR.createFromParcel(appended);check(surface.isValid(),"appended Parcel retains the native producer");
        appended.setDataPosition(0);surface.readFromParcel(appended);appended.recycle();check(surface.isValid(),"reading the same producer neither leaks nor releases it");
        long usage=HardwareBuffer.USAGE_CPU_READ_OFTEN|HardwareBuffer.USAGE_CPU_WRITE_OFTEN|HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE|HardwareBuffer.USAGE_GPU_COLOR_OUTPUT;
        HardwareBuffer hardware=HardwareBuffer.create(4,4,HardwareBuffer.RGBA_8888,1,usage);
        check(hardware.getWidth()==4&&hardware.getHeight()==4&&hardware.getLayers()==1&&hardware.getUsage()==usage,"original HardwareBuffer metadata uses the native allocation");
        GraphicBuffer graphic=GraphicBuffer.createFromHardwareBuffer(hardware);canvas=graphic.lockCanvas();canvas.drawColor(0xff1234ab);graphic.unlockCanvasAndPost(canvas);
        surface.attachAndQueueBufferWithColorSpace(hardware,ColorSpace.get(ColorSpace.Named.SRGB));
        check(output.pixel(2,1)==0xff1234ab,"GraphicBuffer Canvas pixels reach the real Surface target");
        Parcel hardwareParcel=Parcel.obtain();hardware.writeToParcel(hardwareParcel,0);hardwareParcel.setDataPosition(0);
        HardwareBuffer received=HardwareBuffer.CREATOR.createFromParcel(hardwareParcel);
        check(received.getId()==hardware.getId(),"Parcel shares one real native buffer");
        graphic.destroy();hardware.close();hardwareParcel.recycle();
        check(received.getWidth()==4&&!received.isClosed(),"original received buffer survives sender and Parcel close");
        surface.attachAndQueueBufferWithColorSpace(received,ColorSpace.get(ColorSpace.Named.SRGB));
        received.close();check(received.isClosed(),"original HardwareBuffer close releases its Java owner");
        try(var transaction=new SurfaceControl.Transaction()){transaction.setDestinationFrame(child,new Rect(1,1,3,3)).apply();}
        canvas=surface.lockCanvas(null);canvas.drawColor(0xff00ffff);surface.unlockCanvasAndPost(canvas);
        check(output.pixel(2,1)==0&&output.pixel(3,2)==0xff00ffff,"destination frame scales and positions real buffer pixels");
        try(var transaction=new SurfaceControl.Transaction()){transaction.setDestinationFrame(child,4,4).setCornerRadius(child,2).apply();}
        canvas=surface.lockCanvas(null);canvas.drawColor(0xffffffff);surface.unlockCanvasAndPost(canvas);
        check((output.pixel(2,1)>>>24)<255&&output.pixel(3,2)==0xffffffff,"rounded layer clips corners while retaining interior pixels");
        child.release();check(surface.isValid(),"producer ownership survives releasing the control wrapper");
        surface.release();root.release();session.kill();check(NativeSurface.statistics()[0]==0,"native buffers retired");
        SurfaceControl packedControl=new SurfaceControl.Builder().setName("RGB565 buffer").setBufferSize(8,4).setFormat(PixelFormat.RGB_565).build();
        Surface packedSurface=new Surface(packedControl);long packedWindow=NativeSurface.acquire(packedSurface);
        check(Arrays.equals(NativeSurface.geometry(packedWindow),new int[]{8,4,PixelFormat.RGB_565}),"original SurfaceControl keeps actual RGB565 storage");
        var packedQueue=new BLASTBufferQueue("RGB565 extent",false);packedQueue.update(packedControl,9,5,PixelFormat.RGB_565);
        check(Arrays.equals(NativeSurface.geometry(packedWindow),new int[]{9,5,PixelFormat.RGB_565}),"RGB565 survives BLAST extent updates and odd row widths");
        packedQueue.destroy();NativeSurface.releaseWindow(packedWindow);packedSurface.release();packedControl.release();
        SurfaceControl selectedControl=new SurfaceControl.Builder().setName("producer-selected format").setBufferSize(8,4).build();
        Surface selectedSurface=new Surface(selectedControl);long selectedWindow=NativeSurface.acquire(selectedSurface);
        NativeSurface.resize(HostSurface.nativeLease(selectedSurface),8,4,PixelFormat.RGB_565);
        try(var transaction=new SurfaceControl.Transaction()){transaction.setBufferSize(selectedControl,10,5).apply();}
        check(Arrays.equals(NativeSurface.geometry(selectedWindow),new int[]{10,5,PixelFormat.RGB_565}),"extent update retains actual native producer format instead of stale Java metadata");
        NativeSurface.releaseWindow(selectedWindow);selectedSurface.release();selectedControl.release();
        check(NativeSurface.statistics()[0]==0,"RGB565 buffers retire with their upstream owners");
        // A SurfaceView backing color is below its native image; Java widgets
        // remain above. Only scene ownership is simulated, never rendered pixels.
        var overlay=new Output();SurfaceControl overlayRoot=HostSurfaceControl.rootSurfaceControl("overlay",8,8,overlay);
        SurfaceControl container=new SurfaceControl.Builder().setName("surface view").setParent(overlayRoot).setContainerLayer().build();
        SurfaceControl backdrop=new SurfaceControl.Builder().setName("backing color").setParent(container).setColorLayer().build();
        SurfaceControl nativeLayer=new SurfaceControl.Builder().setName("native image").setParent(container).setBufferSize(4,4).build();
        SurfaceControl widget=new SurfaceControl.Builder().setName("widget").setParent(overlayRoot).setColorLayer().build();
        String graphics=runtime.resolve("native/libklepton-graphics.dylib").toString();scenePresenter(graphics,true);
        Surface nativeImage=new Surface(nativeLayer);scenePresenter(graphics,false);
        try(var transaction=new SurfaceControl.Transaction()){
            transaction.show(container).setPosition(container,2,1).show(backdrop).setColor(backdrop,new float[]{0,0,0}).setCrop(backdrop,new Rect(0,0,4,4)).setLayer(backdrop,-1)
                .show(nativeLayer).setLayer(nativeLayer,0).show(widget).setColor(widget,new float[]{1,0,0}).setCrop(widget,new Rect(0,0,1,1)).setPosition(widget,3,2).setLayer(widget,1).apply();
        }
        long producer=sceneAttach(nativeImage);HostSurfaceControl.refreshNativePresentation(overlayRoot);
        check(overlay.pixel(2,1)==0&&overlay.pixel(5,4)==0,"native image clears backing color only at its scene position");
        check(overlay.pixel(3,2)==0xffff0000,"Java widget remains above the native image");
        int submissions=overlay.submitted;HostSurfaceControl.refreshNativePresentation(overlayRoot);check(overlay.submitted==submissions,"unchanged native producer does not recompose every frame");
        sceneDetach(producer);HostSurfaceControl.refreshNativePresentation(overlayRoot);
        check(overlay.pixel(2,1)==0xff000000&&overlay.pixel(3,2)==0xffff0000,"native detach restores backing color without losing upper UI");
        nativeImage.release();nativeLayer.release();backdrop.release();widget.release();container.release();overlayRoot.release();
        check(NativeSurface.statistics()[0]==0,"native scene fixture retires every buffer");
        // Original SurfaceView places its native image relative to the window
        // buffer through a Bounds container. Relative Z must cross that container
        // without moving its coordinate/visibility ownership.
        var relativeOutput=new Output();var relativeRoot=HostSurfaceControl.rootSurfaceControl("relative output",8,8,relativeOutput);
        var ui=new SurfaceControl.Builder().setName("window UI").setParent(relativeRoot).setBufferSize(8,8).build();
        var bounds=new SurfaceControl.Builder().setName("Bounds").setParent(ui).setContainerLayer().build();
        var underneath=new SurfaceControl.Builder().setName("SurfaceView").setParent(bounds).setContainerLayer().build();
        var backing=new SurfaceControl.Builder().setName("backing").setParent(underneath).setColorLayer().build();
        var nativeBuffer=new SurfaceControl.Builder().setName("BLAST").setParent(underneath).setBufferSize(4,4).build();
        Surface uiSurface=new Surface(ui);Canvas uiCanvas=uiSurface.lockCanvas(null);uiCanvas.drawColor(Color.TRANSPARENT,PorterDuff.Mode.CLEAR);Paint ink=new Paint();ink.setColor(Color.RED);uiCanvas.drawRect(3,2,4,3,ink);uiSurface.unlockCanvasAndPost(uiCanvas);
        scenePresenter(graphics,true);Surface relativeImage=new Surface(nativeBuffer);scenePresenter(graphics,false);
        try(var transaction=new SurfaceControl.Transaction()){
            transaction.show(ui).show(bounds).setPosition(bounds,2,1).show(underneath).setRelativeLayer(underneath,ui,-2)
                .show(backing).setColor(backing,new float[]{0,0,0}).setCrop(backing,new Rect(0,0,4,4)).setLayer(backing,-1).show(nativeBuffer).apply();
        }
        long relativeProducer=sceneAttach(relativeImage);HostSurfaceControl.refreshNativePresentation(relativeRoot);
        check(relativeOutput.pixel(3,2)==Color.RED,"ancestor-relative native surface cannot erase later window UI");
        check(relativeOutput.pixel(2,1)==0,"relative native layer retains its actual Bounds transform");
        sceneDetach(relativeProducer);HostSurfaceControl.refreshNativePresentation(relativeRoot);
        check(relativeOutput.pixel(2,1)==Color.BLACK&&relativeOutput.pixel(3,2)==Color.RED,"relative native retirement retains both backdrop and UI ordering");
        relativeImage.release();uiSurface.release();nativeBuffer.release();backing.release();underneath.release();bounds.release();ui.release();relativeRoot.release();
        check(NativeSurface.statistics()[0]==0,"relative scene retires all native buffers");
        AtomicInteger frames=new AtomicInteger();long time=System.nanoTime(),period=16_666_667L;
        var receiver=new DisplayEventReceiver(loop){@Override public void onVsync(long timestamp,long display,int frame,VsyncEventData data){check(Looper.myLooper()==loop,"display callback owner");check(timestamp==time&&display==7&&data.frameInterval==period,"display source fields retained");frames.incrementAndGet();}};
        receiver.scheduleVsync();receiver.scheduleVsync();check(HostDisplayEvents.hostNeedsFrames(),"native clock demand");
        HostDisplayEvents.hostDispatchFrame(1,time,time+period,period,7);check(frames.get()==0,"event is queued on its Looper");HostLooper.drain(loop);check(frames.get()==1,"one pending vsync");
        receiver.dispose();HostDisplayEvents.hostShutdown();HostLooper.close(loop);
        System.out.println("PASS raw Surface/SurfaceControl/BLAST Canvas composition, actual IOSurface ownership, and queued display-event transport");
    }
}
