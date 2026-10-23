package android.graphics;

public final class TransferModeProbe {
    private static void pixel(String label,int actual,int expected){
        for(int shift=0;shift<=24;shift+=8)
            if(Math.abs(((actual>>>shift)&255)-((expected>>>shift)&255))>1)
                throw new AssertionError(label+": "+Integer.toHexString(actual)+" != "+Integer.toHexString(expected));
    }
    private static int draw(int destination,int source,PorterDuff.Mode mode){
        Bitmap bitmap=Bitmap.createBitmap(1,1,Bitmap.Config.ARGB_8888);
        try{Canvas canvas=new Canvas(bitmap);canvas.drawColor(destination,PorterDuff.Mode.SRC);canvas.drawColor(source,mode);return bitmap.getPixel(0,0);}
        finally{bitmap.recycle();}
    }
    public static void main(String[] args){
        java.nio.file.Path runtime=java.nio.file.Path.of(args[0]);
        System.setProperty("klepton.bridge",runtime.resolve("native/libklepton-jvm.dylib").toString());
        System.load(System.getProperty("klepton.bridge"));
        System.load(runtime.resolve("native/libnativebinding.dylib").toString());
        maclauncher.android.framework.JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));
        maclauncher.android.framework.JvmNativeMemory.initialize();
        int s=0xffc04080,d=0xff4080c0;
        for(PorterDuff.Mode mode:PorterDuff.Mode.values()){
            int expected=switch(mode){
                case CLEAR,SRC_OUT,DST_OUT,XOR->0;
                case SRC,SRC_OVER,SRC_IN,SRC_ATOP->s;
                case DST,DST_OVER,DST_IN,DST_ATOP->d;
                case DARKEN->0xff404080;case LIGHTEN->0xffc080c0;
                case MULTIPLY->0xff302060;case SCREEN->0xffd0a0e0;
                case ADD->0xffffc0ff;case OVERLAY->0xff6041c0;
            };
            pixel("opaque "+mode,draw(d,s,mode),expected);
            if(PorterDuff.intToMode(PorterDuff.modeToInt(mode))!=mode)throw new AssertionError("mode identity");
        }
        pixel("half source-over",draw(0x800000ff,0x80ff0000,PorterDuff.Mode.SRC_OVER),0xc0aa0055);
        pixel("half multiply",draw(0x800000ff,0x80ff0000,PorterDuff.Mode.MULTIPLY),0x40000000);
        pixel("half darken",draw(0x800000ff,0x80ff0000,PorterDuff.Mode.DARKEN),0xc0550055);
        pixel("half lighten",draw(0x800000ff,0x80ff0000,PorterDuff.Mode.LIGHTEN),0xc0aa00aa);
        pixel("half screen",draw(0x800000ff,0x80ff0000,PorterDuff.Mode.SCREEN),0xc0aa00aa);
        pixel("half overlay",draw(0x800000ff,0x80ff0000,PorterDuff.Mode.OVERLAY),0xc05500aa);
        pixel("half addition",draw(0x800000ff,0x80ff0000,PorterDuff.Mode.ADD),0xff800080);
        Paint paint=new Paint();var mode=new PorterDuffXfermode(PorterDuff.Mode.SRC);
        if(paint.setXfermode(mode)!=mode||paint.getXfermode()!=mode||new Paint(paint).getXfermode()!=mode)throw new AssertionError("Paint copy/return contract");
        Paint copy=new Paint();copy.set(paint);if(copy.getXfermode()!=mode)throw new AssertionError("Paint.set contract");
        if(copy.setXfermode(null)!=null||copy.getXfermode()!=null)throw new AssertionError("clear mode");
        Bitmap bitmap=Bitmap.createBitmap(3,1,Bitmap.Config.ARGB_8888);
        Bitmap input=Bitmap.createBitmap(new int[]{0xffff0000},1,1,Bitmap.Config.ARGB_8888);
        try{
            Canvas canvas=new Canvas(bitmap);canvas.drawColor(0xff0000ff);
            paint.setAlpha(128);paint.setAntiAlias(false);paint.setFilterBitmap(false);
            canvas.drawBitmap(input,0,0,paint);
            pixel("bitmap opacity",bitmap.getPixel(0,0),0x80ff0000);
            paint.setColor(0x8000ff00);canvas.drawRect(1,0,2,1,paint);
            pixel("primitive alpha once",bitmap.getPixel(1,0),0x8000ff00);
            canvas.save();canvas.clipRect(2,0,3,1);canvas.drawColor(0,PorterDuff.Mode.CLEAR);canvas.restore();
            pixel("clip clears inside",bitmap.getPixel(2,0),0);
            pixel("clip preserves outside",bitmap.getPixel(1,0),0x8000ff00);
            canvas.drawColor(0,PorterDuff.Mode.CLEAR);
            paint.setColor(0xffff0000);int layer=canvas.saveLayerAlpha(null,128);canvas.drawRect(0,0,2,1,paint);canvas.drawRect(1,0,3,1,paint);canvas.restoreToCount(layer);
            pixel("group alpha",bitmap.getPixel(1,0),0x80ff0000);
            canvas.setBitmap(null);
        }finally{bitmap.recycle();input.recycle();}
        System.out.println("PASS Canvas transfer modes, alpha, clipping, Paint copies");
    }
}
