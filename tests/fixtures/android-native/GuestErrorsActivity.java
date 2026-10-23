package probe;
import android.opengl.GLES20;
public final class GuestErrorsActivity extends android.app.Activity {
 @Override protected void onCreate(android.os.Bundle state){super.onCreate(state);android.opengl.GLSurfaceView view=new android.opengl.GLSurfaceView(this);
 view.setRenderer(new android.opengl.GLSurfaceView.Renderer(){int frames,observed,resizes;boolean pending;int[] texture={0};final java.nio.IntBuffer filter=java.nio.ByteBuffer.allocateDirect(4).order(java.nio.ByteOrder.nativeOrder()).asIntBuffer();
  void consume(){if(!pending)return;int error=GLES20.glGetError();if(error!=0x500)throw new AssertionError("Guest GLES error was consumed or changed: "+error);if(GLES20.glGetError()!=0)throw new AssertionError("Unexpected second error");pending=false;observed++;}
  public void onSurfaceCreated(javax.microedition.khronos.opengles.GL10 gl,javax.microedition.khronos.egl.EGLConfig config){GLES20.glGenTextures(1,texture,0);GLES20.glBindTexture(0xDE1,texture[0]);}
  public void onSurfaceChanged(javax.microedition.khronos.opengles.GL10 gl,int width,int height){consume();GLES20.glViewport(0,0,width,height);System.err.println("GUEST_ERROR_RESIZE "+(++resizes)+" "+width+"x"+height+" observed="+observed);}
  public void onDrawFrame(javax.microedition.khronos.opengles.GL10 gl){consume();GLES20.glClearColor(.125f,.5f,.75f,1);GLES20.glClear(0x4000);
   if(++frames==7){java.nio.ByteBuffer pixels=java.nio.ByteBuffer.allocateDirect(4);GLES20.glReadPixels(0,0,1,1,0x1908,0x1401,pixels);int r=pixels.get(0)&255,g=pixels.get(1)&255,b=pixels.get(2)&255;if(Math.abs(r-32)>1||Math.abs(g-128)>1||Math.abs(b-191)>1)throw new AssertionError("Valid draw failed after guest error: "+r+","+g+","+b);System.err.println("GUEST_ERROR_VALID_DRAW_PASS "+r+","+g+","+b);}
   if(frames>=4){GLES20.glTexParameteri(0xDE1,0x2800,0x2703);pending=true;GLES20.glGetTexParameteriv(0xDE1,0x2800,filter);if(filter.get(0)!=0x2601)throw new AssertionError("Invalid command changed magnification filter");}
  }
 });setContentView(view);}
}
