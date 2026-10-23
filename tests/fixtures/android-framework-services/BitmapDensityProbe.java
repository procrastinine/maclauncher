package maclauncher.android;

import android.app.*;
import android.content.*;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.*;
import android.util.DisplayMetrics;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.*;
import maclauncher.android.fixture.RuntimeFixture;

public final class BitmapDensityProbe {
    private static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
    private static void pixels(Context context,int density){
        Bitmap piece=Bitmap.createBitmap(24,24,Bitmap.Config.ARGB_8888);
        Bitmap board=Bitmap.createBitmap(96,96,Bitmap.Config.ARGB_8888);
        Canvas canvas=new Canvas(board);
        try{
            int actual=context.getResources().getDisplayMetrics().densityDpi;
            check(actual==density,"Resource density: "+actual+" expected "+density);
            check(piece.getDensity()==density,"New bitmap density: "+piece.getDensity()+" expected "+density);
            canvas.setDensity(actual);piece.eraseColor(Color.RED);
            canvas.drawBitmap(piece,8,8,null);
            check(board.getPixel(31,31)==Color.RED,"Full bitmap remains visible");
            check(board.getPixel(32,16)==Color.TRANSPARENT,"Bitmap must not spill beyond its pixel width");
            check(board.getPixel(16,32)==Color.TRANSPARENT,"Bitmap must not spill beyond its pixel height");
        }finally{canvas.setBitmap(null);piece.recycle();board.recycle();}
    }
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]).toRealPath(),data=Files.createDirectories(Path.of(args[1])).toRealPath();
        Looper loop=RuntimeFixture.initialize(runtime.toString(),data.toString(),runtime.resolve("native/libklepton-graphics.dylib").toString());
        Path apk=data.resolve("fixture.apk");SyntheticResources.apk(apk,"","Density",null);
        maclauncher.android.fixture.PackageManifest.add(apk,"window");
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
        HostContext.hostPackage("org.example.window","1",1);
        HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);
        HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);
        HostContext.hostClassLoader(BitmapDensityProbe.class.getClassLoader());HostPackages.inspectSources(List.of(apk));
        // Force the old default to be cached before the native display arrives.
        Bitmap early=Bitmap.createBitmap(1,1,Bitmap.Config.ARGB_8888);
        check(early.getDensity()==160,"Initial upstream baseline");
        HostDisplay.hostPublish(1,1920,1200,60,2);
        HostApplication.prepare(BitmapDensityProbe.class.getClassLoader());
        Context context=HostApplication.applicationContext();Application app=new Application();HostApplication.attach(app,context);HostApplication.create(app);
        try{
            pixels(context,320);
            check(early.getDensity()==160,"Existing bitmap metadata must retain its original density");
            HostDisplay.hostPublish(2,960,600,60,1);pixels(context,160);
            HostDisplay.hostPublish(1,1920,1200,60,2);pixels(context,320);
        }finally{early.recycle();HostApplication.shutdown();HostWindowManager.shutdown();HostDisplay.hostShutdown();HostDisplay.hostRemove();FrameworkResources.shutdown();HostLooper.close(loop);HostContext.hostShutdown();}
        System.out.println("PASS bitmap pixel extent and density across original application bind and display changes");
    }
}
