package com.maclauncher.artprobe;
import android.app.Activity;
import android.os.Bundle;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.view.View;
/** An ordinary APK Activity; rendering and lifecycle remain original Android APIs. */
public final class ProbeActivity extends Activity {
 public static int created,destroyed,draws,touches;
 @Override public void onCreate(Bundle state){super.onCreate(state);created++;setContentView(new View(this){
  final Paint paint=new Paint();
  @Override protected void onDraw(Canvas canvas){draws++;canvas.drawColor(0xff25a751);paint.setColor(0xffdc4125);canvas.drawRect(40,30,140,110,paint);}
  @Override public boolean onTouchEvent(android.view.MotionEvent event){if(event.getAction()==android.view.MotionEvent.ACTION_UP)touches++;return true;}
 });}
 @Override public void onDestroy(){destroyed++;super.onDestroy();}
}
