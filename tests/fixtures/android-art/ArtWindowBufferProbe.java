import android.graphics.SurfaceTexture;
import android.view.Surface;
import android.opengl.*;
import java.nio.*;

/** Original Surface/BufferQueue and EGL with independent producer geometry. */
public final class ArtWindowBufferProbe {
    private static native int geometry(Surface surface,int width,int height);
    private static native long defaults(Surface surface);
    private static void check(boolean okay,String message){if(!okay)throw new AssertionError(message+" EGL="+Integer.toHexString(EGL14.eglGetError()));}
    private static void extent(EGLDisplay display,EGLSurface surface,int width,int height){
        int[] value={0};check(EGL14.eglQuerySurface(display,surface,EGL14.EGL_WIDTH,value,0)&&value[0]==width,"width expected="+width+" actual="+value[0]);
        check(EGL14.eglQuerySurface(display,surface,EGL14.EGL_HEIGHT,value,0)&&value[0]==height,"height expected="+height+" actual="+value[0]);
    }
    private static int shader(int type,String source){int shader=GLES20.glCreateShader(type);GLES20.glShaderSource(shader,source);GLES20.glCompileShader(shader);int[] okay={0};GLES20.glGetShaderiv(shader,GLES20.GL_COMPILE_STATUS,okay,0);check(okay[0]!=0,GLES20.glGetShaderInfoLog(shader));return shader;}
    private static void queuedPixels(SurfaceTexture consumer,int texture){
        int program=GLES20.glCreateProgram();int vertex=shader(GLES20.GL_VERTEX_SHADER,"attribute vec2 p; varying vec2 uv; void main(){ gl_Position=vec4(p,0.,1.); uv=(p+1.)*.5; }");
        int fragment=shader(GLES20.GL_FRAGMENT_SHADER,"#extension GL_OES_EGL_image_external : require\nprecision mediump float; varying vec2 uv; uniform samplerExternalOES image; void main(){gl_FragColor=texture2D(image,uv);}");
        GLES20.glAttachShader(program,vertex);GLES20.glAttachShader(program,fragment);GLES20.glLinkProgram(program);int[] okay={0};GLES20.glGetProgramiv(program,GLES20.GL_LINK_STATUS,okay,0);check(okay[0]!=0,GLES20.glGetProgramInfoLog(program));GLES20.glUseProgram(program);
        FloatBuffer points=ByteBuffer.allocateDirect(8*4).order(ByteOrder.nativeOrder()).asFloatBuffer();points.put(new float[]{-1,-1,1,-1,-1,1,1,1}).flip();int location=GLES20.glGetAttribLocation(program,"p");GLES20.glEnableVertexAttribArray(location);GLES20.glVertexAttribPointer(location,2,GLES20.GL_FLOAT,false,0,points);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,texture);GLES20.glUniform1i(GLES20.glGetUniformLocation(program,"image"),0);GLES20.glViewport(0,0,4,4);GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP,0,4);
        ByteBuffer bytes=ByteBuffer.allocateDirect(4);for(int y:new int[]{0,3})for(int x:new int[]{0,3}){bytes.clear();GLES20.glReadPixels(x,y,1,1,GLES20.GL_RGBA,GLES20.GL_UNSIGNED_BYTE,bytes);check((bytes.get(0)&255)==0&&(bytes.get(1)&255)==0&&(bytes.get(2)&255)==255,"queued buffer corner "+x+","+y+" rgb="+(bytes.get(0)&255)+","+(bytes.get(1)&255)+","+(bytes.get(2)&255));}
        check(GLES20.glGetError()==0,"queued buffer sampling");GLES20.glDeleteProgram(program);GLES20.glDeleteShader(vertex);GLES20.glDeleteShader(fragment);
    }
    public static void main(String[] args){
        System.load(args[0]);SurfaceTexture consumer=new SurfaceTexture(false);consumer.setDefaultBufferSize(64,48);Surface nativeWindow=new Surface(consumer);
        EGLDisplay display=EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);int[] version=new int[2];check(EGL14.eglInitialize(display,version,0,version,1),"initialize");
        EGLConfig[] configs=new EGLConfig[1];int[] count={0};check(EGL14.eglChooseConfig(display,new int[]{EGL14.EGL_SURFACE_TYPE,EGL14.EGL_WINDOW_BIT|EGL14.EGL_PBUFFER_BIT,EGL14.EGL_RENDERABLE_TYPE,EGL14.EGL_OPENGL_ES2_BIT,EGL14.EGL_RED_SIZE,8,EGL14.EGL_GREEN_SIZE,8,EGL14.EGL_BLUE_SIZE,8,EGL14.EGL_ALPHA_SIZE,0,EGL14.EGL_NONE},0,configs,0,1,count,0)&&count[0]>0,"config");
        EGLContext context=EGL14.eglCreateContext(display,configs[0],EGL14.EGL_NO_CONTEXT,new int[]{EGL14.EGL_CONTEXT_CLIENT_VERSION,2,EGL14.EGL_NONE},0);
        EGLSurface read=EGL14.eglCreatePbufferSurface(display,configs[0],new int[]{EGL14.EGL_WIDTH,4,EGL14.EGL_HEIGHT,4,EGL14.EGL_NONE},0),window=EGL14.EGL_NO_SURFACE;
        try{
            check(geometry(nativeWindow,32,24)==0,"request geometry");check(defaults(nativeWindow)==((64L<<32)|48L),"original queries retain consumer defaults");
            window=EGL14.eglCreateWindowSurface(display,configs[0],nativeWindow,new int[]{EGL14.EGL_NONE},0);check(window!=EGL14.EGL_NO_SURFACE,"create window");extent(display,window,32,24);check(EGL14.eglMakeCurrent(display,window,read,context),"independent read surface");
            System.out.println("CONTEXT version="+GLES20.glGetString(GLES20.GL_VERSION)+" renderer="+GLES20.glGetString(GLES20.GL_RENDERER));
            int[] texture={0};GLES20.glGenTextures(1,texture,0);consumer.attachToGLContext(texture[0]);
            check(geometry(nativeWindow,20,16)==0,"resize request");GLES20.glClearColor(1,0,0,1);GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);check(EGL14.eglSwapBuffers(display,window),"resize swap");extent(display,window,20,16);check(EGL14.eglGetCurrentSurface(EGL14.EGL_READ).equals(read),"independent read binding preserved");consumer.updateTexImage();
            check(EGL14.eglMakeCurrent(display,window,window,context),"window drawing");GLES20.glViewport(0,0,20,16);GLES20.glClearColor(0,0,1,1);GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);check(EGL14.eglSwapBuffers(display,window),"blue swap");consumer.updateTexImage();
            check(EGL14.eglMakeCurrent(display,read,read,context),"read queued pixels");queuedPixels(consumer,texture[0]);
            check(EGL14.eglMakeCurrent(display,window,window,context),"restore window");check(geometry(nativeWindow,0,0)==0,"restore automatic geometry");check(EGL14.eglSwapBuffers(display,window),"default resize swap");extent(display,window,64,48);consumer.updateTexImage();
            check(EGL14.eglMakeCurrent(display,read,read,context),"retire window");check(EGL14.eglDestroySurface(display,window),"destroy dequeued buffer");window=EGL14.EGL_NO_SURFACE;
            for(int i=0;i<8;i++){check(geometry(nativeWindow,32,24)==0,"repeat geometry");EGLSurface next=EGL14.eglCreateWindowSurface(display,configs[0],nativeWindow,new int[]{EGL14.EGL_NONE},0);check(next!=EGL14.EGL_NO_SURFACE,"recreate after cancel "+i);extent(display,next,32,24);check(EGL14.eglDestroySurface(display,next),"cancel "+i);}
            consumer.detachFromGLContext();System.out.println("PASS original ART BufferQueue producer geometry, resize, queued pixels, independent read surface and dequeue cancellation");
        }finally{EGL14.eglMakeCurrent(display,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_CONTEXT);if(window!=EGL14.EGL_NO_SURFACE)EGL14.eglDestroySurface(display,window);EGL14.eglDestroySurface(display,read);EGL14.eglDestroyContext(display,context);EGL14.eglTerminate(display);nativeWindow.release();consumer.release();}
    }
}
