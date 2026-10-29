import android.graphics.*;
import android.os.*;
import android.hardware.HardwareBuffer;
import android.media.ImageReader;
import android.view.*;
import java.nio.file.*;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.atomic.*;
import java.util.concurrent.*;
import maclauncher.android.framework.*;
import maclauncher.android.bridge.NativeSurface;

/** Original framework clients backed by actual host buffers; display ticks are controlled inputs. */
public final class NativeSurfaceFrameworkProbe {
    static native void scenePresenter(String graphics,boolean enabled);
    static native long sceneAttach(Surface surface);
    static native void sceneDetach(long owner);
    static native int[] videoFailureRecovery(Surface surface);
    static native long[] storageInfo(String library,int format);
    static void check(boolean value,String label){if(!value)throw new AssertionError(label);}
    static void imageFormats()throws Exception{
        Class<?> type=Class.forName("android.media.PublicFormatUtils");
        var hal=type.getDeclaredMethod("getHalFormat",int.class);var space=type.getDeclaredMethod("getHalDataspace",int.class);var publicFormat=type.getDeclaredMethod("getPublicFormat",int.class,int.class);
        hal.setAccessible(true);space.setAccessible(true);publicFormat.setAccessible(true);
        for(String name:new String[]{"nativeGetHalFormat","nativeGetHalDataspace","nativeGetPublicFormat"}){
            var method=name.equals("nativeGetPublicFormat")?type.getDeclaredMethod(name,int.class,int.class):type.getDeclaredMethod(name,int.class);
            check(method.getReturnType()==int.class&&!java.lang.reflect.Modifier.isNative(method.getModifiers()),"every original PublicFormatUtils native descriptor has its concrete device boundary");
        }
        int jfif=android.hardware.DataSpace.DATASPACE_JFIF,depth=android.hardware.DataSpace.DATASPACE_DEPTH;
        int[][] formats={
            {ImageFormat.JPEG,HardwareBuffer.BLOB,jfif},{ImageFormat.DEPTH_POINT_CLOUD,HardwareBuffer.BLOB,depth},
            {ImageFormat.DEPTH_JPEG,HardwareBuffer.BLOB,android.hardware.DataSpace.DATASPACE_DYNAMIC_DEPTH},
            {ImageFormat.HEIC,HardwareBuffer.BLOB,android.hardware.DataSpace.DATASPACE_HEIF},
            {0x1006,HardwareBuffer.BLOB,android.hardware.DataSpace.DATASPACE_HEIF_ULTRAHDR},
            {ImageFormat.JPEG_R,HardwareBuffer.BLOB,android.hardware.DataSpace.DATASPACE_JPEG_R},
            {ImageFormat.DEPTH16,0x20363159,depth},{0x1002,ImageFormat.RAW_SENSOR,depth},{0x1003,ImageFormat.RAW10,depth},
            {ImageFormat.RAW_SENSOR,ImageFormat.RAW_SENSOR,1},{ImageFormat.RAW_PRIVATE,ImageFormat.RAW_PRIVATE,1},
            {ImageFormat.RAW10,ImageFormat.RAW10,1},{ImageFormat.RAW12,ImageFormat.RAW12,1},
            {ImageFormat.YUV_420_888,ImageFormat.YUV_420_888,jfif},{ImageFormat.NV21,ImageFormat.NV21,jfif},{ImageFormat.YV12,ImageFormat.YV12,jfif},
            {PixelFormat.RGBA_8888,PixelFormat.RGBA_8888,0},{54,54,0},{60,60,0}
        };
        for(int[] format:formats){
            check((int)hal.invoke(null,format[0])==format[1]&&(int)space.invoke(null,format[0])==format[2],"original public format maps to actual HAL format/dataspace: "+Integer.toHexString(format[0]));
            check((int)publicFormat.invoke(null,format[1],format[2])==format[0],"HAL format/dataspace reverses to original public format: "+Integer.toHexString(format[0]));
        }
        check((int)hal.invoke(null,0x4abcd)==0x4abcd&&(int)space.invoke(null,0x4abcd)==0&&(int)publicFormat.invoke(null,0x4abcd,0)==ImageFormat.UNKNOWN,"unknown format conversions preserve the original forward/reverse defaults");
        check((int)publicFormat.invoke(null,5,0)==ImageFormat.UNKNOWN&&(int)publicFormat.invoke(null,HardwareBuffer.BLOB,0)==ImageFormat.JPEG,"BGRA remains nonpublic and unspecified BLOB retains the original JPEG default");
    }
    static final class Output implements HostSurface.Target {
        int[] pixels;int width,height,submitted;
        public boolean submit(int[] pixels,int width,int height,long frame,long time){this.pixels=pixels.clone();this.width=width;this.height=height;submitted++;return true;}
        public void resize(int width,int height){this.width=width;this.height=height;}
        int pixel(int x,int y){return pixels[y*width+x];}
    }
    static void imageReader(Looper loop)throws Exception{
        long usage=HardwareBuffer.USAGE_CPU_READ_OFTEN|HardwareBuffer.USAGE_CPU_WRITE_OFTEN|HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE;
        HardwareBuffer retained;
        try(var reader=ImageReader.newInstance(3,2,PixelFormat.RGBA_8888,2,usage)){
            check(reader.acquireNextImage()==null,"empty ImageReader has no fabricated image");
            AtomicInteger callbacks=new AtomicInteger();reader.setOnImageAvailableListener(value->callbacks.incrementAndGet(),new Handler(loop));
            Surface surface=reader.getSurface();Canvas canvas=surface.lockCanvas(null);canvas.drawColor(0xff1234ab);surface.unlockCanvasAndPost(canvas);
            var first=reader.acquireNextImage();
            canvas=surface.lockCanvas(null);canvas.drawColor(0xff5678cd);surface.unlockCanvasAndPost(canvas);
            var second=reader.acquireNextImage();
            HostLooper.drain(loop);check(callbacks.get()==2,"original ImageReader listeners run once per produced image");
            reader.discardFreeBuffers();
            try(first;second){
                check(first!=null&&second!=null&&first.getWidth()==3&&first.getHeight()==2,"original ImageReader acquires real producer images");
                var plane=first.getPlanes()[0];var bytes=plane.getBuffer();
                check(plane.getPixelStride()==4&&plane.getRowStride()>=12&&bytes.capacity()>=plane.getRowStride()*2,"image plane exposes actual row layout");
                check((bytes.get(0)&255)==0x12&&(bytes.get(1)&255)==0x34&&(bytes.get(2)&255)==0xab,"ImageReader plane is the posted RGBA image");
                boolean exhausted=false;try{reader.acquireNextImage();}catch(IllegalStateException expected){exhausted=true;}
                check(exhausted,"maxImages applies while acquired images remain open");
                retained=first.getHardwareBuffer();try(var another=first.getHardwareBuffer()){
                    check(retained.getId()==another.getId(),"HardwareBuffer wrappers retain the same physical image");
                }
            }
            check(reader.acquireNextImage()==null,"released images are not queued again");
            canvas=surface.lockCanvas(null);canvas.drawColor(Color.GREEN);surface.unlockCanvasAndPost(canvas);
            try(var next=reader.acquireNextImage()){
                check(next!=null&&(next.getPlanes()[0].getBuffer().get(1)&255)==255,"released capacity accepts the next image");
                check(!next.getFence().isValid(),"completed CPU image has no fabricated asynchronous fence");
                reader.detachImage(next);check(next.isAttachable(),"original detach state survives the platform queue operation");
            }
        }
        try(retained){
            check(retained.getWidth()==3&&!retained.isClosed(),"HardwareBuffer retains its frame after Image and reader close");
            GraphicBuffer graphic=GraphicBuffer.createFromHardwareBuffer(retained);
            try{
                Canvas canvas=graphic.lockCanvas();canvas.drawColor(Color.RED);graphic.unlockCanvasAndPost(canvas);
                var planes=ImageReader.initializeImagePlanes(1,graphic,-1,PixelFormat.RGBA_8888,0,0,0,new Rect(0,0,3,2));
                check(planes.length==1&&planes[0].getPixelStride()==4&&(planes[0].getBuffer().get(0)&255)==255,"static ImageReader planes share original GraphicBuffer storage");
                boolean locked=false;try{locked=graphic.lockCanvas()==null;}catch(IllegalStateException expected){locked=true;}
                check(locked,"image lock excludes a conflicting Canvas lock");ImageReader.unlockGraphicBuffer(graphic);
                canvas=graphic.lockCanvas();graphic.unlockCanvasAndPost(canvas);
                boolean twice=false;try{ImageReader.unlockGraphicBuffer(graphic);}catch(IllegalStateException expected){twice=true;}
                check(twice,"unlock without a matching image lock fails");
            }finally{graphic.destroy();}
        }
        check(NativeSurface.statistics()[0]==0,"ImageReader releases its shared surface buffers");
    }
    static Surface alias(Surface source){var parcel=Parcel.obtain();try{source.writeToParcel(parcel,0);parcel.setDataPosition(0);return Surface.CREATOR.createFromParcel(parcel);}finally{parcel.recycle();}}
    static void post(ImageReader reader,int color){Surface surface=reader.getSurface();Canvas canvas=surface.lockCanvas(null);canvas.drawColor(color);surface.unlockCanvasAndPost(canvas);}
    static void imageReaderQueue(Looper loop)throws Exception{
        long usage=HardwareBuffer.USAGE_CPU_READ_OFTEN|HardwareBuffer.USAGE_CPU_WRITE_OFTEN;
        try(var frame=HardwareBuffer.create(1,1,HardwareBuffer.RGBA_8888,1,usage);var reader=ImageReader.newInstance(1,1,PixelFormat.RGBA_8888,1,usage)){
            var callbacks=new AtomicInteger();reader.setOnImageAvailableListener(value->callbacks.incrementAndGet(),new Handler(loop));
            // Producer and listener share this Looper. Queuing cannot wait for
            // the callback behind it, even when maxImages is one.
            for(int i=0;i<20;i++)post(reader,0xff000000|i);
            HostLooper.drain(loop);check(callbacks.get()>0,"same-thread producer leaves ImageReader listener runnable");
            var held=reader.acquireNextImage();check(held!=null&&(held.getPlanes()[0].getBuffer().get(2)&255)==19,"queued app-controlled frames are replaced by the newest frame");
            reader.detachImage(held);check(held.isAttachable(),"detached image retains original attachable state");
            Surface first=alias(reader.getSurface()),second=alias(reader.getSurface());
            try{
                var failure=new AtomicReference<Throwable>();var completed=new AtomicInteger();
                Runnable produce=()->{try{Surface target=Thread.currentThread().getName().endsWith("a")?first:second;for(int i=0;i<20;i++)target.attachAndQueueBufferWithColorSpace(frame,null);completed.incrementAndGet();}catch(Throwable error){failure.compareAndSet(null,error);}};
                Thread a=new Thread(produce,"ImageReader producer a"),b=new Thread(produce,"ImageReader producer b");a.setDaemon(true);b.setDaemon(true);a.start();b.start();a.join(2000);b.join(2000);
                check(!a.isAlive()&&!b.isAlive()&&completed.get()==2&&failure.get()==null,"concurrent producers do not wait for acquired or detached images");
                boolean max=false;try{reader.acquireNextImage();}catch(IllegalStateException expected){max=true;}
                check(max,"detach releases the producer slot but retains the original acquired-image pool entry");
            }finally{held.close();first.release();second.release();}
            try(var latest=reader.acquireNextImage()){check(latest!=null,"detached-image close restores acquire capacity");}
            post(reader,Color.GREEN);reader.close();
        }
        try(var reader=ImageReader.newInstance(1,1,PixelFormat.RGBA_8888,2,usage);var hardware=HardwareBuffer.create(5,3,HardwareBuffer.RGBA_8888,1,usage)){
            reader.getSurface().attachAndQueueBufferWithColorSpace(hardware,null);
            try(var image=reader.acquireLatestImage();var actual=image.getHardwareBuffer()){
                check(reader.getWidth()==1&&reader.getHeight()==1&&image.getWidth()==5&&image.getHeight()==3,"image dimensions follow the actual producer allocation");
                check(actual.getId()==hardware.getId(),"queued HardwareBuffer retains the actual producer allocation without a color copy");
            }
        }
        check(NativeSurface.statistics()[0]==0,"droppable ImageReader producers retire every surface");
    }
    static void imageReaderFormats()throws Exception{
        long usage=HardwareBuffer.USAGE_CPU_READ_OFTEN|HardwareBuffer.USAGE_CPU_WRITE_OFTEN|HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE;
        HardwareBuffer retained;
        try(var reader=ImageReader.newInstance(4,2,ImageFormat.YUV_420_888,2,usage)){
            post(reader,Color.RED);
            try(var image=reader.acquireNextImage()){
                check(image.getFormat()==ImageFormat.YUV_420_888&&image.getWidth()==4&&image.getHeight()==2,"flexible YUV image preserves its public format and actual dimensions");
                var planes=image.getPlanes();check(planes.length==3&&planes[0].getPixelStride()==1&&planes[1].getPixelStride()==2&&planes[2].getPixelStride()==2,"NV12 storage exposes the original three YUV planes and chroma strides");
                check(Math.abs((planes[0].getBuffer().get(0)&255)-76)<=1&&Math.abs((planes[1].getBuffer().get(0)&255)-85)<=1&&(planes[2].getBuffer().get(0)&255)>=254,"YUV planes contain converted producer luma and chroma");
                check((planes[0].getBuffer().get(planes[0].getRowStride()+3)&255)==(planes[0].getBuffer().get(0)&255),"final luma sample is backed by actual storage");
                retained=image.getHardwareBuffer();check(retained.getFormat()==HardwareBuffer.YCBCR_420_888,"YUV HardwareBuffer describes its actual backing format");
            }
        }
        try(retained){
            GraphicBuffer graphic=GraphicBuffer.createFromHardwareBuffer(retained);
            try{var planes=ImageReader.initializeImagePlanes(3,graphic,-1,ImageFormat.YUV_420_888,0,0,0,new Rect(0,0,4,2));check(planes.length==3&&(planes[2].getBuffer().get(0)&255)>=254,"static planes retain the same YUV allocation after reader close");ImageReader.unlockGraphicBuffer(graphic);}
            finally{graphic.destroy();}
        }
        try(var reader=ImageReader.newInstance(1,1,ImageFormat.PRIVATE,2,HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE);var hardware=HardwareBuffer.create(4,2,HardwareBuffer.RGBA_8888,1,usage)){
            reader.getSurface().attachAndQueueBufferWithColorSpace(hardware,null);
            try(var image=reader.acquireNextImage();var actual=image.getHardwareBuffer()){
                check(image.getFormat()==ImageFormat.PRIVATE&&image.getPlanes().length==0,"PRIVATE reader exposes opaque images without CPU planes");
                check(image.getWidth()==4&&image.getHeight()==2&&actual.getId()==hardware.getId()&&actual.getFormat()==HardwareBuffer.RGBA_8888,"PRIVATE retains actual producer size, format and hardware allocation");
            }
        }
        for(int format:new int[]{PixelFormat.RGB_888,PixelFormat.RGB_565,HardwareBuffer.RGBA_FP16,PixelFormat.RGBA_1010102,ImageFormat.Y8,0x20363159,54,60}){
            try(var reader=format==HardwareBuffer.RGBA_FP16||format==PixelFormat.RGBA_1010102?
                    new ImageReader.Builder(4,2).setDefaultHardwareBufferFormat(format).setMaxImages(2).setUsage(usage).build():
                    ImageReader.newInstance(4,2,format,2,usage)){
                post(reader,Color.WHITE);
                try(var image=reader.acquireNextImage()){
                    check(image.getFormat()==format,"packed/monochrome/high-bit-depth image keeps its public format");
                    var planes=image.getPlanes();int count=format==54||format==60?3:1;check(planes.length==count,"actual format supplies its original plane count");
                    for(var plane:planes)check(plane.getBuffer().isDirect()&&plane.getRowStride()>0&&plane.getPixelStride()>0,"format planes expose real native storage and strides");
                    int stride=switch(format){case PixelFormat.RGB_888->3;case PixelFormat.RGB_565,0x20363159,54,60->2;case HardwareBuffer.RGBA_FP16->8;case PixelFormat.RGBA_1010102->4;default->1;};
                    check(planes[0].getPixelStride()==stride,"packed format pixel stride matches its actual element width");
                }
            }catch(Throwable failure){throw new AssertionError("ImageReader format 0x"+Integer.toHexString(format)+" failed",failure);}
        }
        Bitmap source=Bitmap.createBitmap(2,2,Bitmap.Config.ARGB_8888);source.eraseColor(Color.BLUE);var encoded=new java.io.ByteArrayOutputStream();
        check(source.compress(Bitmap.CompressFormat.JPEG,90,encoded),"original Bitmap producer encodes a real JPEG");source.recycle();byte[] jpeg=encoded.toByteArray();
        try(var reader=ImageReader.newInstance(2,2,ImageFormat.JPEG,2,usage);var hardware=HardwareBuffer.create(jpeg.length+8,1,HardwareBuffer.BLOB,1,usage)){
            GraphicBuffer graphic=GraphicBuffer.createFromHardwareBuffer(hardware);
            try{var planes=ImageReader.initializeImagePlanes(1,graphic,-1,ImageFormat.JPEG,0,0,0,new Rect(0,0,jpeg.length+8,1));var bytes=planes[0].getBuffer().order(java.nio.ByteOrder.nativeOrder());bytes.put(jpeg);bytes.putInt(jpeg.length,0xff);bytes.putInt(jpeg.length+4,jpeg.length);ImageReader.unlockGraphicBuffer(graphic);}
            catch(Throwable error){var converter=Class.forName("android.media.PublicFormatUtils").getDeclaredMethod("getHalFormat",int.class);converter.setAccessible(true);throw new AssertionError("JPEG planes: public="+ImageFormat.JPEG+", original HAL="+converter.invoke(null,ImageFormat.JPEG)+", buffer="+hardware.getFormat(),error);}
            finally{graphic.destroy();}
            reader.getSurface().attachAndQueueBufferWithColorSpace(hardware,null);
            try(var image=reader.acquireNextImage()){
                check(image.getWidth()==2&&image.getHeight()==2,"original JPEG image wrappers retain pixel dimensions independently of the encoded byte allocation");
                var bytes=image.getPlanes()[0].getBuffer();byte[] actual=new byte[bytes.remaining()];bytes.get(actual);
                check(image.getFormat()==ImageFormat.JPEG&&Arrays.equals(actual,jpeg),"JPEG BLOB transport preserves encoded bytes and the original camera footer length");
            }
        }
        try(var reader=ImageReader.newInstance(4,2,ImageFormat.RAW_SENSOR,2,usage);var hardware=HardwareBuffer.create(4,2,ImageFormat.RAW_SENSOR,1,usage)){
            GraphicBuffer graphic=GraphicBuffer.createFromHardwareBuffer(hardware);
            try{var planes=ImageReader.initializeImagePlanes(1,graphic,-1,ImageFormat.RAW_SENSOR,0,0,0,new Rect(0,0,4,2));planes[0].getBuffer().order(java.nio.ByteOrder.nativeOrder()).putShort(0,(short)0x3210);ImageReader.unlockGraphicBuffer(graphic);}
            finally{graphic.destroy();}
            reader.getSurface().attachAndQueueBufferWithColorSpace(hardware,null);
            try(var image=reader.acquireNextImage()){var plane=image.getPlanes()[0];check(image.getFormat()==ImageFormat.RAW_SENSOR&&plane.getPixelStride()==2&&plane.getBuffer().order(java.nio.ByteOrder.nativeOrder()).getShort(0)==0x3210,"RAW16 transport preserves producer sensor bytes without a fabricated color conversion");}
        }
        for(int format:new int[]{ImageFormat.RAW_PRIVATE,ImageFormat.RAW10,ImageFormat.RAW12,ImageFormat.NV16,ImageFormat.YV12,ImageFormat.DEPTH16,ImageFormat.DEPTH_POINT_CLOUD,ImageFormat.DEPTH_JPEG,ImageFormat.HEIC,ImageFormat.JPEG_R})
            try(var reader=ImageReader.newInstance(4,2,format,1,usage)){check(reader.getImageFormat()==format&&reader.acquireNextImage()==null,"queue construction preserves original raw/encoded format APIs without inventing producer data");}
        check(NativeSurface.statistics()[0]==0,"all image formats retire their actual producer surfaces");
    }
    static void videoRecovery(){
        Surface surface=new Surface();var calls=new AtomicInteger();var width=new AtomicInteger();var height=new AtomicInteger();
        HostSurface.bind(surface,1,1,PixelFormat.RGBA_8888,new HostSurface.Target(){
            public boolean submit(int[] pixels,int w,int h,long frame,long time){if(calls.getAndIncrement()==0)throw new IllegalArgumentException("fixture consumer rejects its first frame");width.set(w);height.set(h);return true;}
            public void resize(int w,int h){}
        });
        try{int[] result=videoFailureRecovery(surface);check(result!=null&&result[0]!=0&&result[1]==0&&result[2]==0&&result[3]==0,"native video returns its first failure and clears only its contained JNI error before the next frame");check(calls.get()==2&&width.get()==3&&height.get()==2,"native video keeps delivering actual resized frames after a consumer error");}
        finally{surface.release();}
        check(NativeSurface.statistics()[0]==0,"native video consumer releases its retained Surface");
    }
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Path.of(args[1]);Files.createDirectories(data.resolve("files"));Files.createDirectories(data.resolve("cache"));
        HostFilesystem.configure(runtime,data,data.resolve("files"),data.resolve("cache"),"owned.surface");
        System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
        System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());System.load(runtime.resolve("native/libnativebinding.dylib").toString());maclauncher.android.framework.HostProcessIdentity.initializeIds();
        JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));JvmNativeMemory.initialize();
        System.load(args[2]);
        if(args.length==5&&args[3].equals("storage")){
            for(int format:new int[]{1,2,3,4,22,43,34,35,54,60,56,0x20203859,0x20363159,32,33}){
                try{long[] info=storageInfo(args[4],format);check(info!=null&&info[0]==1&&info[1]>0&&info[4]==1,"real IOSurface allocation, format identity and native pixel roundtrip");
                    int count=format==35||format==54||format==60?3:1;check(info[2]==count,"actual logical storage plane count");
                    for(int i=0;i<count;i++)check(info[5+3*i]>0&&info[6+3*i]>0&&info[7+3*i]>0,"direct plane addresses, row/pixel strides and bounded spans");
                    if(format==4)check(info[3]==16&&info[6]==2&&info[5]>=8,"primary CoreVideo RGB565 description and true two-byte row layout");
                }catch(Throwable error){throw new AssertionError("Native storage format 0x"+Integer.toHexString(format)+" failed",error);}
            }
            var publicFormat=Class.forName("android.media.PublicFormatUtils").getDeclaredMethod("getPublicFormat",int.class,int.class);publicFormat.setAccessible(true);
            System.out.println("Original native P210 public-format mapping: "+publicFormat.invoke(null,60,0));
            System.out.println("PASS actual native hardware storage format matrix and disposal");return;
        }
        imageFormats();
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
        imageReader(loop);
        imageReaderQueue(loop);
        imageReaderFormats();
        videoRecovery();
        AtomicInteger frames=new AtomicInteger();long time=System.nanoTime(),period=16_666_667L;
        var receiver=new DisplayEventReceiver(loop){@Override public void onVsync(long timestamp,long display,int frame,VsyncEventData data){check(Looper.myLooper()==loop,"display callback owner");check(timestamp==time&&display==7&&data.frameInterval==period,"display source fields retained");frames.incrementAndGet();}};
        receiver.scheduleVsync();receiver.scheduleVsync();check(HostDisplayEvents.hostNeedsFrames(),"native clock demand");
        HostDisplayEvents.hostDispatchFrame(1,time,time+period,period,7);check(frames.get()==0,"event is queued on its Looper");HostLooper.drain(loop);check(frames.get()==1,"one pending vsync");
        receiver.dispose();HostDisplayEvents.hostShutdown();HostLooper.close(loop);
        System.out.println("PASS raw Surface/SurfaceControl/BLAST Canvas composition, actual IOSurface ownership, and queued display-event transport");
    }
}
