import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import maclauncher.android.framework.HostSystemFonts;

/** Uses original font parsing, Minikin, Paint and Canvas without a window. */
public final class SystemFontsProbe {
    public static void main(String[] args) {
        java.io.PrintStream output=new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out));
        try {
            if(!Typeface.getSystemFontMap().isEmpty())throw new AssertionError("Expected app_process without zygote font publication");
            HostSystemFonts.initialize(null);
            Typeface original=Typeface.DEFAULT;
            if(original==null||!Typeface.getSystemFontMap().containsKey("sans-serif"))throw new AssertionError("Original system font map is absent");
            Paint paint=new Paint();paint.setColor(Color.WHITE);paint.setTextSize(36);
            if(!(paint.measureText("Android")>0))throw new AssertionError("Original native text measurement failed");
            Bitmap bitmap=Bitmap.createBitmap(256,64,Bitmap.Config.ARGB_8888);
            new Canvas(bitmap).drawText("Android",4,45,paint);
            int[] pixels=new int[256*64];bitmap.getPixels(pixels,0,256,0,0,256,64);
            boolean drawn=false;for(int pixel:pixels)drawn|=(pixel>>>24)!=0;
            if(!drawn)throw new AssertionError("Original text rasterization produced no pixels");
            HostSystemFonts.initialize(null);
            if(Typeface.DEFAULT!=original)throw new AssertionError("Existing default Typeface was replaced");
            bitmap.recycle();
            output.println("PASS original ART font initialization, Paint measurement, Canvas pixels and retained map");
        }catch(Throwable failure){failure.printStackTrace(new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.err)));System.exit(1);}
    }
}
