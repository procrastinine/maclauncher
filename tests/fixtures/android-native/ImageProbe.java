package maclauncher.android;

import android.content.Context;
import android.graphics.*;
import android.graphics.drawable.*;
import android.widget.ImageView;

/** Original ImageView geometry rendered through the native Canvas/Bitmap adapter. */
public final class ImageProbe {
    private static final int RED=0xffff0000;
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static Bitmap render(ImageView image){
        Bitmap output=Bitmap.createBitmap(10,10,Bitmap.Config.ARGB_8888);
        Canvas canvas=new Canvas(output);image.draw(canvas);check(canvas.getSaveCount()==1,"ImageView leaked canvas state");canvas.setBitmap(null);return output;
    }
    public static void run(Context context){
        check(ImageView.class.getClassLoader()==android.view.View.class.getClassLoader(),"Original framework owns ImageView");
        Bitmap source=Bitmap.createBitmap(new int[]{RED,RED,RED,RED,RED,RED,RED,RED},4,2,Bitmap.Config.ARGB_8888);
        source.setDensity(Bitmap.DENSITY_NONE);
        try{
            ImageView.ScaleType[] modes={ImageView.ScaleType.FIT_XY,ImageView.ScaleType.FIT_START,ImageView.ScaleType.FIT_CENTER,ImageView.ScaleType.FIT_END,ImageView.ScaleType.CENTER,ImageView.ScaleType.CENTER_INSIDE,ImageView.ScaleType.CENTER_CROP,ImageView.ScaleType.MATRIX};
            int[][] rectangles={{1,1,9,9},{1,1,9,5},{1,3,9,7},{1,5,9,9},{3,4,7,6},{3,4,7,6},{1,1,9,9},{1,1,5,3}};
            for(int i=0;i<modes.length;i++){
                ImageView image=new ImageView(context);image.setImageBitmap(source);image.setPadding(1,1,1,1);image.setCropToPadding(true);image.setScaleType(modes[i]);image.layout(0,0,10,10);
                BitmapDrawable drawable=(BitmapDrawable)image.getDrawable();drawable.setFilterBitmap(false);
                check(drawable.getCallback()==image,"Original drawable callback owner");
                Bitmap output=render(image);int[] box=rectangles[i];
                try{for(int y=0;y<10;y++)for(int x=0;x<10;x++)check(output.getPixel(x,y)==(x>=box[0]&&x<box[2]&&y>=box[1]&&y<box[3]?RED:0),modes[i]+" at "+x+","+y);}finally{output.recycle();}
                image.setImageDrawable(null);check(drawable.getCallback()==null&&!source.isRecycled(),"Replacing a drawable releases its callback, not the caller's bitmap");
            }
        }finally{source.recycle();}
        var parent=new android.widget.FrameLayout(context);parent.setBackgroundColor(0xff000000);
        var child=new android.view.View(context){protected void onDraw(Canvas canvas){Paint paint=new Paint();paint.setColor(RED);canvas.drawRect(0,0,7,6,paint);paint.setColor(0xff0000ff);canvas.drawRect(3,0,9,6,paint);}};
        child.setWillNotDraw(false);parent.addView(child,new android.widget.FrameLayout.LayoutParams(9,6));parent.layout(0,0,12,10);child.layout(2,2,11,8);child.setAlpha(.5f);
        Bitmap output=Bitmap.createBitmap(12,10,Bitmap.Config.ARGB_8888);Canvas canvas=new Canvas(output);
        try{parent.draw(canvas);check(output.getPixel(3,3)==0xff7f0000&&output.getPixel(6,3)==0xff00007f,"original child offset and truncated group alpha: "+Integer.toHexString(output.getPixel(3,3))+","+Integer.toHexString(output.getPixel(6,3)));check(output.getPixel(1,1)==0xff000000&&output.getPixel(11,8)==0xff000000,"original parent clipping");child.setVisibility(android.view.View.INVISIBLE);parent.draw(canvas);check(output.getPixel(3,3)==0xff000000,"original invisible child handling");}
        finally{canvas.setBitmap(null);output.recycle();}
    }
}
