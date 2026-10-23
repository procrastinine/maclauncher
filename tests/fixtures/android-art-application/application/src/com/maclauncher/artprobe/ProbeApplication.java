package com.maclauncher.artprobe;
import android.app.Application;
import android.graphics.Bitmap;
import java.io.*;
import java.nio.charset.StandardCharsets;
public final class ProbeApplication extends Application {
 public static int starts;
 @Override public void onCreate() {
  super.onCreate();starts++;
  try {
   if(starts!=1)throw new AssertionError("Application lifecycle repeated");
   try(InputStream input=getAssets().open("payload.txt")){String value=new String(input.readAllBytes(),StandardCharsets.UTF_8);if(!value.equals("Original APK asset through guest libandroidfw\n"))throw new AssertionError("APK asset");}
   int label=getResources().getIdentifier("app_name","string",getPackageName());if(label==0||!"ART application boundary".equals(getString(label)))throw new AssertionError("APK resource");
   try(FileOutputStream output=new FileOutputStream(new File(getFilesDir(),"created.txt"))){output.write("original Application onCreate".getBytes(StandardCharsets.UTF_8));}
   Bitmap bitmap=Bitmap.createBitmap(8,8,Bitmap.Config.ARGB_8888);bitmap.eraseColor(0xff36a258);if(bitmap.getPixel(1,1)!=0xff36a258)throw new AssertionError("bitmap");bitmap.recycle();
  }catch(IOException failure){throw new AssertionError(failure);}
 }
}
