import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Exercises the actual common JNI entry points in either original VM. */
public final class BrowserTransportProbe {
    private static native void open(String socket,String token);
    private static native void dispatch();
    private static native void close();
    private static native String initialize(String directory,String root,boolean allowed);
    private static native long create(BrowserTransportProbe callback);
    private static native void destroy(long handle);
    private static native void size(long handle,int width,int height,float density);
    private static native void visibility(long handle,boolean visible);
    private static native void html(long handle,String html,String base);
    private static native void load(long handle,String url,String[]keys,String[]values,byte[]body);
    private static native void interfaces(long handle,String json);
    private static native void script(long handle,String source,long request);
    private static native void snapshot(long handle);
    private static native void setting(long handle,String name,String json);
    private static native void dialogResult(long handle,long request,boolean yes,String value);
    private static native String cookies(String url);
    private static native void cookieCommand(String op,String json,BrowserTransportProbe callback);
    private static native void storageCommand(String op,String json,BrowserTransportProbe callback);
    private final Map<Long,String> results=new HashMap<>();
    private long handle,request;private int finished,frames,resources,interfaces,dialogs,overrides,completions;
    private boolean red;
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static void await(java.util.function.BooleanSupplier condition,String message)throws Exception{
        long end=System.nanoTime()+15_000_000_000L;
        while(!condition.getAsBoolean()&&System.nanoTime()<end){dispatch();Thread.sleep(2);}
        check(condition.getAsBoolean(),message);
    }
    public void changed(){}
    public void documentDimensions(int width,int height){check(width>=0&&height>=0,"document extents");}
    public void navigation(String state,String url,String title,int progress){if("finished".equals(state))finished++;check(progress>=0&&progress<=100,"progress");}
    public void history(String[]urls,String[]titles,int index){check(urls.length==titles.length&&index<urls.length,"history arrays");}
    public boolean navigateRequest(String url,boolean main,boolean gesture,boolean redirect,String method,String headers){overrides++;setting(handle,"TextZoom","100");return true;}
    public byte[] resource(String url){resources++;return "<html><body style='background:rgb(255,0,0)'>資😀 asset</body></html>".getBytes(StandardCharsets.UTF_8);}
    public void editorState(String json){check(json.contains("identity"),"editor state");}
    public void portMessage(long id,String text){}
    public String invokeInterface(String name,String method,String arguments){interfaces++;setting(handle,"TextZoom","100");check(name.equals("bridge")&&method.equals("echo"),"interface identity");return "{\"ok\":true,\"value\":\"Java 資😀\"}";}
    public void dialog(long id,String kind,String url,String message,String value){dialogs++;dialogResult(handle,id,true,"accepted 資😀");}
    public void scriptResult(long id,String json,String error){check(error==null,"script error: "+error);results.put(id,json);}
    public void frame(ByteBuffer pixels,int width,int height,String error){check(error==null&&pixels!=null,"snapshot: "+error);check(width==96&&height==64&&pixels.capacity()==96*64*4,"snapshot extent");frames++;for(int i=0;i<pixels.capacity();i+=4)if((pixels.get(i+2)&255)>220&&(pixels.get(i+1)&255)<30&&(pixels.get(i)&255)<30){red=true;break;}}
    public void complete(String json,String error){
        check(error==null,"store: "+error);
        if(completions==0){
            System.out.println("Reading the actual cookie owner from its completion callback");
            check(cookies("https://fixture.invalid/").contains("bridge=shared"),"cookie callback reentry");
        }
        completions++;
    }
    private String evaluate(String source)throws Exception{long id=++request;script(handle,source,id);await(()->results.containsKey(id),"script reply");return results.remove(id);}
    public static void main(String[]args)throws Exception{
        System.load(args[0]);open(args[1],args[2]);BrowserTransportProbe probe=new BrowserTransportProbe();
        try{
            check(initialize("/data/user/0/probe/files/webview","/data/user/0/probe",false)!=null,"WebKit version");
            probe.handle=create(probe);size(probe.handle,96,64,1);visibility(probe.handle,true);interfaces(probe.handle,"{\"bridge\":[\"echo\"]}");
            html(probe.handle,"<html><body style='background:rgb(255,0,0)'><script>window.answer=bridge.echo('資😀')</script></body></html>","https://fixture.invalid/");
            await(()->probe.finished>0,"inline document");
            check(probe.evaluate("window.answer").contains("Java 資😀")&&probe.interfaces==1,"VM JavaScript callback and Unicode");
            check(probe.evaluate("confirm('fixture')").equals("true")&&probe.dialogs==1,"reentrant dialog completion");
            probe.evaluate("location.href='fixture://navigation';true");await(()->probe.overrides>0,"reentrant navigation policy");
            int before=probe.finished;load(probe.handle,"file:///android_asset/page.html",new String[0],new String[0],null);await(()->probe.finished>before,"resource document");check(probe.resources>0,"VM resource bytes");
            snapshot(probe.handle);await(()->probe.frames>0,"actual WebKit snapshot");check(probe.red,"actual red pixels");
            cookieCommand("set","{\"url\":\"https://fixture.invalid/\",\"value\":\"bridge=shared; Path=/\"}",probe);await(()->probe.completions==1,"cookie completion");check(cookies("https://fixture.invalid/").contains("bridge=shared"),"actual cookie owner");
            storageCommand("origins","{}",probe);await(()->probe.completions==2,"storage completion");
            destroy(probe.handle);probe.handle=0;System.gc();
            System.out.println("PASS shared WebKit transport: VM callbacks, Unicode, reentry, resources, dialogs, pixels, cookies, storage and retirement");
        }finally{if(probe.handle!=0)destroy(probe.handle);close();}
    }
}
