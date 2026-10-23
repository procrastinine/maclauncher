import android.graphics.*;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.LayerDrawable;
import android.graphics.drawable.VectorDrawable;
import com.android.internal.util.VirtualRefBasePtr;
import android.view.Gravity;
import java.nio.file.Path;

/** Exercises the original AOSP object/state family against its published native implementation. */
public final class NativeGraphicsProbe {
    private static void check(boolean value){if(!value)throw new AssertionError();}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]);
        System.setProperty("klepton.bridge",runtime.resolve("native/libklepton-jvm.dylib").toString());
        System.setProperty("klepton.graphics",runtime.resolve("native/libklepton-graphics.dylib").toString());
        System.load(System.getProperty("klepton.bridge"));
        System.load(runtime.resolve("native/libnativebinding.dylib").toString());
        maclauncher.android.framework.JvmNativeMemory.configure(runtime.resolve("native/libandroid_runtime.dylib"));
        maclauncher.android.framework.JvmNativeMemory.initialize();
        Bitmap source=Bitmap.createBitmap(new int[]{0xffff0000,0xff0000ff},2,1,Bitmap.Config.ARGB_8888);source.setDensity(160);
        Bitmap scaled=Bitmap.createScaledBitmap(source,4,2,false);
        check(scaled.getWidth()==4&&scaled.getHeight()==2&&scaled.getPixel(0,1)==0xffff0000&&scaled.getPixel(3,1)==0xff0000ff);
        Bitmap target=Bitmap.createBitmap(8,8,Bitmap.Config.ARGB_8888);
        {
            VectorDrawable vector=new VectorDrawable();long tree=vector.getNativeTree();check(tree!=0&&vector.getAlpha()==255);
            // Original ConstantState defensively clones mutable native trees for every drawable.
            VectorDrawable sibling=(VectorDrawable)vector.getConstantState().newDrawable();check(sibling.getNativeTree()!=tree);
            sibling.mutate();check(sibling.getNativeTree()!=tree);sibling.setAlpha(73);check(vector.getAlpha()==255&&sibling.getAlpha()==73);
            VirtualRefBasePtr original=new VirtualRefBasePtr(tree),copy=new VirtualRefBasePtr(sibling.getNativeTree());
            original.release();original.release();copy.release();check(original.get()==0&&copy.get()==0);
            // Releasing another strong owner must not release the drawable's native state.
            vector.setAlpha(91);check(vector.getAlpha()==91&&sibling.getAlpha()==73);
        }
        Canvas canvas=new Canvas(target);BitmapDrawable drawable=new BitmapDrawable(null,source);drawable.setBounds(0,0,8,8);drawable.setGravity(Gravity.CENTER);drawable.setFilterBitmap(false);drawable.draw(canvas);
        check(target.getPixel(3,3)==0xffff0000&&target.getPixel(4,3)==0xff0000ff&&target.getPixel(0,0)==0);
        drawable.setTileModeXY(Shader.TileMode.REPEAT,Shader.TileMode.REPEAT);drawable.draw(canvas);
        check(target.getPixel(0,0)==0xffff0000&&target.getPixel(1,0)==0xff0000ff&&target.getPixel(6,6)==0xffff0000);
        BitmapDrawable sibling=(BitmapDrawable)drawable.getConstantState().newDrawable();sibling.mutate().setAlpha(64);check(drawable.getAlpha()==255&&sibling.getAlpha()==64);
        target.eraseColor(0);ColorDrawable bottom=new ColorDrawable(0xffff0000),top=new ColorDrawable(0xff0000ff);
        LayerDrawable layers=new LayerDrawable(new Drawable[]{bottom,top});layers.setLayerInset(1,2,3,1,2);layers.setBounds(0,0,8,8);layers.draw(canvas);
        check(top.getBounds().equals(new Rect(2,3,7,6))&&target.getPixel(0,0)==0xffff0000&&target.getPixel(3,4)==0xff0000ff);
        check(bottom.getCallback()==layers&&top.getCallback()==layers);layers.setDrawable(0,null);check(bottom.getCallback()==null&&top.getCallback()==layers);
        target.eraseColor(0);Paint paint=new Paint();paint.setColor(0xff00ff00);android.graphics.Path path=new android.graphics.Path();path.moveTo(0,0);path.lineTo(8,0);path.lineTo(0,8);path.close();canvas.drawPath(path,paint);check(target.getPixel(1,1)==0xff00ff00&&target.getPixel(7,7)==0);
        paint.setTypeface(Typeface.SANS_SERIF);paint.setTextSize(12);check(paint.measureText("Native text")>0);canvas.drawText("A",0,8,paint);
        Matrix matrix=new Matrix();matrix.setScale(2,3);float[] point={4,5};matrix.mapPoints(point);check(point[0]==8&&point[1]==15);
        {
            Canvas owned=new Canvas(target);
            target.eraseColor(0);owned.save();owned.translate(3,4);owned.clipRect(0,0,1,1);owned.setBitmap(target);owned.setMatrix(null);check(owned.getSaveCount()==1);
            Paint layerPaint=new Paint();layerPaint.setColor(0xffff0000);
            int layer=owned.saveLayerAlpha(null,128);owned.drawRect(0,0,4,4,layerPaint);owned.drawRect(2,0,6,4,layerPaint);owned.restoreToCount(layer);
            check(target.getPixel(1,1)==target.getPixel(3,1)&&(target.getPixel(3,1)>>>24)==128);
            owned.drawColor(0,PorterDuff.Mode.CLEAR);check(target.getPixel(3,1)==0);owned.setBitmap(null);
        }
        canvas.setBitmap(null);source.recycle();scaled.recycle();target.recycle();
        System.out.println("PASS original AOSP graphics: scale, drawable gravity/tile/mutation, path, system font text and native bitmap pixels");
    }
}
