package maclauncher.android;

import android.app.*;
import android.content.*;
import android.os.*;
import android.view.*;
import android.webkit.*;
import java.nio.file.*;
import java.util.*;
import java.util.function.BooleanSupplier;
import maclauncher.android.framework.*;
import maclauncher.android.web.*;
import maclauncher.android.bridge.WindowSession;

/** Real upstream WebView, native WebKit content, and original Android composition. */
public final class WebKitProbe {
    private static Looper loop;private static int[] pixels;
    private static native void pumpNative();
    private static native void inspectNative();
    private static native void activateNative();
    private static native boolean focusWindowNative();
    private static native boolean textNative(int kind,String text);
    private static native int physicalNative(int key,String text,boolean command);
    private static void physicalKey(int action,int code,int unicode,int meta){HostWindowManager.input(HostInput.key(action,code,unicode,meta));}
    private static String evaluate(WebView browser,String script)throws Exception{String[]result={null};browser.evaluateJavascript(script,v->result[0]=v);until(()->result[0]!=null,"local editor result");return result[0];}
    private static void editorText(WebView browser,String expected)throws Exception{long end=System.nanoTime()+5_000_000_000L;String actual;do{pump();actual=evaluate(browser,"document.querySelector(\"#editor\").value");if(org.json.JSONObject.quote(expected).equals(actual))return;Thread.sleep(5);}while(System.nanoTime()<end);throw new AssertionError("editor value mismatch expected="+expected+" actual="+actual+" state="+evaluate(browser,"JSON.stringify({events:window.editorEvents,focus:document.hasFocus()})"));}
    private static void editorSelection(WebView browser,int start,int end)throws Exception{long deadline=System.nanoTime()+5_000_000_000L;String expected="["+start+","+end+"]",actual;do{pump();actual=evaluate(browser,"[document.querySelector('#editor').selectionStart,document.querySelector('#editor').selectionEnd]");if(expected.equals(actual))return;Thread.sleep(5);}while(System.nanoTime()<deadline);throw new AssertionError("editor selection mismatch expected="+expected+" actual="+actual);}
    private static void cookies(WebView browser,String address)throws Exception{
        String result=evaluate(browser,"document.cookie='native_handoff=ready;path=/';fixture.cookie("+org.json.JSONObject.quote(address)+")");
        check(result.contains("native_handoff=ready"),"synchronous CookieManager sees the cookie before JavaScript callback returns");
        System.out.println("PASS WebKit cookie visibility at original Android JavaScript interface");
    }
    private static void navigationPolicy(WebView browser,String address)throws Exception{
        List<String> overrides=new ArrayList<>(),finished=new ArrayList<>();
        browser.setWebViewClient(new WebViewClient(){
            public boolean shouldOverrideUrlLoading(WebView view,String url){
                overrides.add(url);
                if(url.endsWith("/handoff")){view.loadUrl(url);return true;}
                return false;
            }
            public void onPageFinished(WebView view,String url){finished.add(url);}
        });
        browser.loadUrl(address+"/first");until(()->finished.contains(address+"/first"),"application load finishes");
        check(overrides.isEmpty(),"application loadUrl does not invoke shouldOverrideUrlLoading");
        evaluate(browser,"document.body.innerHTML='<a id=link href=\""+address+"/handoff\">link</a>';document.querySelector('#link').click();true");
        until(()->finished.contains(address+"/handoff"),"client can replace a page navigation with an application load");
        check(overrides.equals(List.of(address+"/handoff")),"page link receives exactly one override without recursion");
        overrides.clear();browser.loadUrl(address+"/redirect");until(()->finished.contains(address+"/redirected"),"HTTP redirect finishes");
        check(overrides.equals(List.of(address+"/redirected")),"HTTP redirect retains the original client callback");
        overrides.clear();browser.postUrl(address+"/post",new byte[]{'a','=', '1'});until(()->finished.contains(address+"/post"),"POST finishes");
        check(overrides.isEmpty(),"POST does not invoke shouldOverrideUrlLoading");
        System.out.println("PASS original Android navigation origin: app load, page link, reentrant client handoff, HTTP redirect and POST");
    }
    private static void frameNavigation(WebView browser,String address,boolean networkAllowed)throws Exception{
        List<String> legacy=new ArrayList<>();boolean[] loaded={false};
        browser.setWebViewClient(new WebViewClient(){
            public boolean shouldOverrideUrlLoading(WebView view,String url){legacy.add(url);return true;}
            public void onPageFinished(WebView view,String url){loaded[0]=true;}
        });
        browser.loadDataWithBaseURL(address,"<html><body><div id=retained>original document</div></body></html>","text/html","UTF-8",null);
        until(()->loaded[0],"inline application document loads without a network fetch");
        check(legacy.isEmpty(),"application inline load retains original navigation ownership");
        String first="application-bridge://callback/?value=one%20two";
        evaluate(browser,"(()=>{const frame=document.createElement('iframe');frame.style.display='none';frame.src='"+first+"';document.body.append(frame);return true})()");
        until(()->legacy.contains(first),"hidden iframe reaches original legacy Android client");
        check(legacy.equals(List.of(first)),"one subframe request reaches the legacy callback exactly once");
        List<WebResourceRequest> requests=new ArrayList<>();
        browser.setWebViewClient(new WebViewClient(){public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){requests.add(request);return true;}});
        String second="another-bridge://result/?completed=true";
        evaluate(browser,"(()=>{const frame=document.createElement('iframe');frame.hidden=true;frame.src='"+second+"';document.body.append(frame);return true})()");
        until(()->!requests.isEmpty(),"hidden iframe reaches original typed Android client");
        WebResourceRequest frame=requests.get(0);
        System.out.println("Subframe request url="+frame.getUrl()+" main="+frame.isForMainFrame()+" gesture="+frame.hasGesture()+" redirect="+frame.isRedirect()+" method="+frame.getMethod()+" headers="+frame.getRequestHeaders());
        check(second.equals(frame.getUrl().toString())&&!frame.isForMainFrame()&&!frame.isRedirect()&&frame.getMethod().equals("GET")&&frame.getRequestHeaders()!=null,"subframe URL, frame, redirect, method and headers retain native metadata");
        evaluate(browser,"location.href='application-bridge://main/';true");until(()->requests.size()==2,"main-frame custom navigation reaches client");
        check(requests.get(1).isForMainFrame(),"original client distinguishes main frame and iframe");
        check("\"original document\"".equals(evaluate(browser,"document.querySelector('#retained').textContent")),"handled messages preserve the original page");
        browser.setWebViewClient(new WebViewClient());
        evaluate(browser,"window.network='waiting';fetch('"+address+"').then(r=>r.text()).then(()=>window.network='allowed').catch(()=>window.network='blocked');true");
        until(()->{try{return org.json.JSONObject.quote(networkAllowed?"allowed":"blocked").equals(evaluate(browser,"window.network"));}catch(Exception failure){throw new RuntimeException(failure);}},"actual network policy remains independent of local application messages");
        System.out.println("PASS original Android subframe requests, legacy and typed clients, custom schemes and network isolation");
    }
    private static void keyboard(WebView browser)throws Exception{
        evaluate(browser,"document.body.innerHTML=\"<style>#editor{width:120px;height:40px;border:0;background:#ff0000;color:#000;font:20px monospace;caret-color:transparent}#editor:focus{background:#00ff00}</style><input id=editor><textarea id=area></textarea>\";true");browser.requestFocus();HostWindowManager.focusOutput(true);
        boolean nativeKey=focusWindowNative();
        evaluate(browser,"document.querySelector('#editor').focus();true");
        for(int i=0;i<50;i++){pump();Thread.sleep(2);}inspectNative();System.err.println("FOCUS Android="+browser.hasFocus()+" window="+browser.hasWindowFocus()+" DOM="+evaluate(browser,"JSON.stringify({active:document.activeElement?.id,focused:document.hasFocus(),style:document.querySelector('#editor').matches(':focus')})"));
        check(Boolean.toString(nativeKey).equals(evaluate(browser,"document.querySelector('#editor').matches(':focus')")),"WebKit focused editor style follows actual native key-window state");
        until(()->pixels!=null&&dominant(pixels[20*320+20],nativeKey?8:16),"native focus style is published to Android without typing");
        evaluate(browser,"window.fixtureFrames=0;requestAnimationFrame(()=>{fixtureFrames++;requestAnimationFrame(()=>fixtureFrames++)});true");
        long frameDeadline=System.nanoTime()+3_000_000_000L;String frameState;
        do{pump();frameState=evaluate(browser,"fixtureFrames");if("2".equals(frameState))break;Thread.sleep(5);}while(System.nanoTime()<frameDeadline);
        check("2".equals(frameState),"visible Android WebView advances its original animation clock under a covered native window");
        try{until(HostTextInput::active,"original Android input connection enables native text");}catch(AssertionError failure){var info=new android.view.inputmethod.EditorInfo();browser.onCreateInputConnection(info);var field=HostTextInput.class.getDeclaredField("current");field.setAccessible(true);throw new AssertionError("editor="+info.inputType+" viewFocus="+browser.hasFocus()+" windowFocus="+browser.hasWindowFocus()+" focused="+HostWindowManager.focusedView()+" connection="+field.get(null),failure);}inspectNative();
        until(()->!editorInk(),"empty editor reaches the Android canvas before input");
        check(physicalNative(0,"a",false)>0,"physical printable key enters native text system");editorText(browser,"a");
        until(WebKitProbe::editorInk,"typed text reaches submitted Android canvas pixels");
        evaluate(browser,"const frame=document.createElement('iframe');frame.srcdoc='<html><body>unrelated frame</body></html>';document.body.appendChild(frame);true");for(int i=0;i<80;i++){pump();Thread.sleep(2);}check(HostTextInput.active(),"unrelated iframe must not retire the focused Android editor");
        int physical=physicalNative(51,"\u007f",false);check(physical>0,"physical native Backspace enters SDL");editorText(browser,"");textNative(1,"a");editorText(browser,"a");
        textNative(1,"é😀");editorText(browser,"aé😀");
        evaluate(browser,"window.editorEvents=[];for(const type of [\"compositionstart\",\"compositionupdate\",\"compositionend\",\"input\"])document.addEventListener(type,e=>editorEvents.push([e.type,e.data]),true);true");textNative(2,"に");editorText(browser,"aé😀に");editorSelection(browser,4,4);textNative(2,"日本");editorText(browser,"aé😀日本");editorSelection(browser,4,4);textNative(1,"日本");editorText(browser,"aé😀日本");
        check(physicalNative(0,"a",true)>0,"physical Command-A enters SDL");editorSelection(browser,0,6);textNative(1,"replacement");editorText(browser,"replacement");
        physicalNative(0,"a",true);editorSelection(browser,0,11);physicalNative(8,"c",true);for(int i=0;i<50;i++){pump();Thread.sleep(2);}
        var copied=browser.getContext().getSystemService(android.content.ClipboardManager.class).getPrimaryClip();check(copied!=null&&copied.getItemAt(0).getText().toString().equals("replacement"),"physical Cmd-C invokes original private copy before host export");
        HostTextInput.shortcut(KeyEvent.KEYCODE_A);for(int i=0;i<50;i++){pump();Thread.sleep(2);}HostTextInput.shortcut(KeyEvent.KEYCODE_X);editorText(browser,"");
        var clip=browser.getContext().getSystemService(android.content.ClipboardManager.class).getPrimaryClip();check(clip!=null&&clip.getItemAt(0).getText().toString().equals("replacement"),"Cmd-X remains in Android private clipboard");inspectNative();
        System.out.println("PASS keyboard: single commit, Unicode, IME composition, selection, private cut and native responder ownership");
    }
    private static boolean editorInk(){if(pixels==null)return false;int ink=0;for(int y=4;y<38;y++)for(int x=4;x<100;x++){int color=pixels[y*320+x];if((color>>>24)==255&&(color&0xffffff)<0x202020)ink++;}return ink>4;}
    private static void documentLayout(WebView browser)throws Exception{
        evaluate(browser,"document.body.innerHTML='<div style=\"width:800px;height:1200px\"><div id=box style=\"width:100px;height:40px\"></div><span id=words style=\"font:20px monospace\">Text</span></div>';true");
        until(()->browser.getContentHeight()==1200,"content height reports the document in CSS pixels, not the Retina snapshot");
        check(pixels.length==640*480,"document extent does not resize the Android viewport bitmap");
        double textBefore=Double.parseDouble(evaluate(browser,"document.querySelector('#words').getBoundingClientRect().height"));
        browser.getSettings().setTextZoom(200);
        double textAfter=0;long deadline=System.nanoTime()+5_000_000_000L;
        do{pump();textAfter=Double.parseDouble(evaluate(browser,"document.querySelector('#words').getBoundingClientRect().height"));if(textAfter>textBefore*1.7)break;Thread.sleep(5);}while(System.nanoTime()<deadline);
        check(textAfter>textBefore*1.7,"text zoom increases original WebKit text layout");
        check(Double.parseDouble(evaluate(browser,"document.querySelector('#box').getBoundingClientRect().width"))==100,"text zoom leaves fixed CSS geometry unchanged");
        check(browser.getScale()==2,"text zoom does not change page scale");
        browser.setInitialScale(150);browser.getSettings().setTextZoom(100);
        until(()->browser.getScale()==3,"page zoom remains independent of text zoom");
        evaluate(browser,"document.body.firstElementChild.style.height='1600px';true");
        until(()->browser.getContentHeight()==1600,"document extent follows layout changes without a new page load");
        System.out.println("PASS WebKit document extent and independent text zoom");
    }
    private static void pixelTransfer(WebView browser)throws Exception{
        var providerField=WebView.class.getDeclaredField("mProvider");providerField.setAccessible(true);
        var adapter=(WebKitView)java.lang.reflect.Proxy.getInvocationHandler(providerField.get(browser));
        var bitmapField=WebKitView.class.getDeclaredField("bitmap");bitmapField.setAccessible(true);
        var buffer=java.nio.ByteBuffer.allocateDirect(16).order(java.nio.ByteOrder.nativeOrder());
        buffer.putInt(0xffff0000).putInt(0xff0000ff).putInt(0x80402010).putInt(0);
        adapter.frame(buffer,2,2,null);var first=(android.graphics.Bitmap)bitmapField.get(adapter);
        check(first.getPixel(0,0)==0xffff0000&&first.getPixel(1,0)==0xff0000ff,"raw browser pixels preserve red/blue channel order");
        check(first.getPixel(0,1)==0x80804020&&first.getPixel(1,1)==0,"premultiplied browser pixels preserve translucent and transparent values");
        buffer.rewind();buffer.putInt(0xff00ff00).putInt(0).putInt(0).putInt(0);
        adapter.frame(buffer,2,2,null);check(bitmapField.get(adapter)==first&&first.getPixel(0,0)==0xff00ff00&&first.getPixel(0,1)==0,"same-size pixel transfer reuses the Bitmap and replaces transparency");
        var smaller=java.nio.ByteBuffer.allocateDirect(12).order(java.nio.ByteOrder.nativeOrder());smaller.putInt(0xff112233).putInt(0xff445566).putInt(0xff778899);
        adapter.frame(smaller,3,1,null);var resized=(android.graphics.Bitmap)bitmapField.get(adapter);
        check(first.isRecycled()&&resized.getWidth()==3&&resized.getHeight()==1&&resized.getPixel(2,0)==0xff778899,"resize releases the old Bitmap and preserves new row layout");
        System.out.println("PASS WebKit reusable pixel transfer: native channel order, premultiplied alpha, reuse and resize");
    }
    private static void pump(){pumpNative();HostLooper.drain(loop);}
    private static void until(BooleanSupplier ready,String description)throws Exception{long end=System.nanoTime()+15_000_000_000L;while(!ready.getAsBoolean()&&System.nanoTime()<end){pump();Thread.sleep(2);}if(!ready.getAsBoolean())throw new AssertionError(description);}
    private static void check(boolean value,String description){if(!value)throw new AssertionError(description);}
    private static boolean dominant(int color,int shift){return (color>>>24)==255&&((color>>>shift)&255)>=192&&(color&0xffffff&~(255<<shift))==0;}
    public static final class ScriptBridge {
        @JavascriptInterface public int add(int a,int b){return a+b;}
        @JavascriptInterface public String cookie(String address){return CookieManager.getInstance().getCookie(address);}
        public String hidden(){throw new AssertionError("unannotated Java method exposed");}
    }
    public static final class BrowserActivity extends Activity {
        WebView browser;
        @Override protected void onCreate(Bundle saved){super.onCreate(saved);setTheme(android.R.style.Theme_Material_Light_NoActionBar);browser=new WebView(this);setContentView(browser);}
    }
    public static void main(String[]args)throws Exception{
        boolean policy=args.length>6&&args[6].equals("policy");boolean frames=args.length>6&&args[6].equals("frames");boolean layout=args.length>6&&args[6].equals("layout");boolean keyboard=args.length>6&&args[6].equals("keyboard");boolean pixelTransfer=args.length>6&&args[6].equals("pixels");boolean navigation=args.length>6&&args[6].equals("navigation");boolean background=policy||frames||layout||keyboard||pixelTransfer||navigation||args.length>6&&args[6].equals("cookies");boolean retina=layout||args.length>6&&args[6].equals("retina");int pixelWidth=retina?640:320,pixelHeight=retina?480:240;float density=retina?2:1;
        Path runtime=Path.of(args[0]).toRealPath(),data=Files.createDirectories(Path.of(args[1])).toRealPath();
        loop=maclauncher.android.fixture.RuntimeFixture.initialize(runtime.toString(),data.toString());
        System.load(args[2]);if(args.length>3)System.load(args[3]);HostInput.initialize();
        Path apk=data.resolve("fixture.apk");SyntheticResources.apk(apk,"","Browser",null);maclauncher.android.fixture.PackageManifest.add(apk,"webkit");
        try(var archive=FileSystems.newFileSystem(apk)){Files.createDirectories(archive.getPath("/assets"));Files.writeString(archive.getPath("/assets/page.html"),"<html><body>APK asset</body></html>");}
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));HostContext.hostPackage("org.example.window","1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostContext.hostFilesDirectory(data.resolve("files").toString());HostContext.hostCacheDirectory(data.resolve("cache").toString());HostContext.hostClassLoader(WebKitProbe.class.getClassLoader());HostPackages.inspectSources(List.of(apk));HostDisplay.hostPublish(1,320,240,60);
        WindowSession.configureIdentity("Android browser",null,background);
        WindowSession session=WindowSession.open("Android browser",320,240);if(!background)activateNative();
        HostDisplay.hostPublish(1,pixelWidth,pixelHeight,60,density);
        boolean networkAllowed=Boolean.parseBoolean(args[4]);String networkUrl=args[5];WebKitFactory.configure(Files.createDirectories(data.resolve("files/webview")),networkAllowed,runtime.resolve("android-host.jar"));HostApplication.prepare(WebKitProbe.class.getClassLoader());Context context=HostApplication.applicationContext();Application app=new Application();HostApplication.attach(app,context);HostApplication.create(app);BrowserActivity activity=new BrowserActivity();HostActivity.attach(activity,context,app);SurfaceControl output=null;Throwable first=null;
        try{
            var provider=WebView.getCurrentWebViewPackage();check(provider!=null&&provider.packageName.equals("maclauncher.android.webkit"),"original package discovery works before WebView construction");
            session.attachActivity(activity);
            try{WebKitFactory.configure(data.resolve("files/webview"),!networkAllowed,runtime.resolve("android-host.jar"));throw new AssertionError("browser network scope was mutable after bootstrap");}catch(IllegalStateException expected){}
            HostActivity.start(activity,null);HostActivity.resume(activity);WebView browser=activity.browser;browser.getSettings().setJavaScriptEnabled(true);browser.addJavascriptInterface(new ScriptBridge(),"fixture");
            output=HostSurfaceControl.rootSurfaceControl("webview",pixelWidth,pixelHeight,new HostSurface.Target(){public boolean submit(int[]value,int w,int h,long id,long time){pixels=value.clone();return true;}public void resize(int w,int h){}});HostWindowManager.attachOutput(activity,output,pixelWidth,pixelHeight);HostActivity.owner(activity).focus(true);
            if(policy){navigationPolicy(browser,networkUrl);browser.destroy();return;}
            if(frames){frameNavigation(browser,networkUrl,networkAllowed);browser.destroy();return;}
            boolean[] loaded={false};List<String> navigations=new ArrayList<>();browser.setWebViewClient(new WebViewClient(){public boolean shouldOverrideUrlLoading(WebView view,String url){navigations.add(url);check(!url.startsWith("android-"),"private browser transport URL leaked into Android client");return false;}public void onPageFinished(WebView view,String url){loaded[0]=true;System.out.println("page finished "+url);}public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){System.err.println("page error "+error.getDescription());}});
            browser.loadDataWithBaseURL(networkUrl,"<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body style='margin:0;background:#ff0000'><button id='go' style='width:120px;height:80px' onclick=\"document.body.style.background='#00ff00';window.clicked=true\">Play</button></body></html>","text/html","UTF-8",null);
            try{until(()->loaded[0]&&pixels!=null&&Arrays.stream(pixels).anyMatch(p->dominant(p,16)),"actual WebKit red pixels reach original Android surface");}catch(AssertionError error){System.err.println("loaded="+loaded[0]+" view="+browser.getWidth()+"x"+browser.getHeight()+" pixels="+(pixels==null?"null":Arrays.stream(pixels).distinct().limit(12).mapToObj(Integer::toHexString).toList()));throw error;}
            if(navigation){
                List<String> finished=new ArrayList<>(),visited=new ArrayList<>();int[]starts={0};browser.setWebViewClient(new WebViewClient(){public void onPageStarted(WebView view,String url,android.graphics.Bitmap icon){starts[0]++;}public void onPageFinished(WebView view,String url){finished.add(url);}public void doUpdateVisitedHistory(WebView view,String url,boolean reload){visited.add(url);}});
                evaluate(browser,"location.hash='complete';true");until(()->finished.contains(networkUrl+"#complete"),"original Android onPageFinished receives main-frame fragment navigation");
                check(starts[0]==0,"fragment navigation does not invent onPageStarted");check((networkUrl+"#complete").equals(browser.getUrl()),"original WebView URL follows fragment");
                int fragmentCount=finished.size();String next=networkUrl+"?state=2";evaluate(browser,"history.pushState({},'',"+org.json.JSONObject.quote(next)+");true");until(()->visited.contains(next),"original visited-history callback receives same-document pushState");check(next.equals(browser.getUrl()),"original WebView URL follows history state");
                String replaced=next+"&replace=1";evaluate(browser,"history.replaceState({},'',"+org.json.JSONObject.quote(replaced)+");true");until(()->visited.contains(replaced),"original visited-history callback receives replaceState");check(finished.size()==fragmentCount&&starts[0]==0,"history API changes do not invent page-load events");
                boolean[]retired={false};browser.setWebViewClient(new WebViewClient(){public void onPageFinished(WebView view,String url){view.destroy();retired[0]=true;}});browser.evaluateJavascript("location.hash='retire';true",null);until(()->retired[0],"original navigation callback can destroy its browser owner");System.out.println("PASS original Android same-document fragment callbacks");return;
            }
            if(args.length>6&&args[6].equals("cookies")){cookies(browser,networkUrl);browser.destroy();return;}
            if(keyboard){keyboard(browser);browser.destroy();return;}
            if(pixelTransfer){pixelTransfer(browser);browser.destroy();return;}
            if(layout){documentLayout(browser);browser.destroy();return;}
            check(pixels.length==pixelWidth*pixelHeight,"WebKit preserves the requested Android pixel extent");
            check(!dominant(pixels[(int)(40*density)*pixelWidth+(int)(50*density)],16)&&dominant(pixels[(int)(200*density)*pixelWidth+(int)(50*density)],16),"page snapshots preserve top-down Android pixel orientation");
            String[] result={null};browser.evaluateJavascript("JSON.stringify([fixture.add(20,22),typeof fixture.hidden])",value->result[0]=value);until(()->result[0]!=null,"JavaScript interface returned");check(result[0].contains("42")&&result[0].contains("undefined"),"only annotated Java methods are exposed");
            result[0]=null;browser.evaluateJavascript("window.points=[];for(const type of ['mousedown','mouseup','click'])document.addEventListener(type,e=>window.points.push([type,e.clientX,e.clientY,e.target.id]),true);true",value->result[0]=value);until(()->result[0]!=null,"DOM input recorder ready");browser.setOnTouchListener((v,event)->{System.out.println("android touch "+event.getActionMasked()+" "+event.getX()+","+event.getY());return false;});inspectNative();
            int[] location=new int[2];browser.getLocationOnScreen(location);HostWindowManager.input(HostInput.motion(MotionEvent.ACTION_DOWN,location[0]+50,location[1]+40));pump();HostWindowManager.input(HostInput.motion(MotionEvent.ACTION_UP,location[0]+50,location[1]+40));
            try{until(()->pixels!=null&&Arrays.stream(pixels).anyMatch(p->dominant(p,8)),"native WebKit click updates original Android surface");}catch(AssertionError error){result[0]=null;browser.evaluateJavascript("JSON.stringify({points,clicked:window.clicked,rect:document.querySelector('#go').getBoundingClientRect().toJSON()})",value->result[0]=value);until(()->result[0]!=null,"DOM input diagnostic");System.err.println("DOM input="+result[0]);throw error;}
            inspectNative();
            if(retina){result[0]=null;browser.evaluateJavascript("JSON.stringify({width:innerWidth,points})",value->result[0]=value);until(()->result[0]!=null,"Retina DOM viewport and input coordinates");String value=new org.json.JSONArray("["+result[0]+"]").getString(0);var resultObject=new org.json.JSONObject(value);check(resultObject.getInt("width")==320,"CSS viewport uses native points");var events=resultObject.getJSONArray("points");var down=events.getJSONArray(0);check(down.getInt(1)==25&&down.getInt(2)==20,"Android pixel input becomes native point coordinates");check(browser.getScale()==2,"Original WebView scale includes display density");browser.destroy();System.out.println("PASS Retina WebKit: native point layout, exact Android pixels and scaled input");return;}
            result[0]=null;browser.evaluateJavascript("window.keys=[];document.addEventListener('keydown',e=>window.keys.push(e.key));true",value->result[0]=value);until(()->result[0]!=null,"DOM key recorder ready");check(browser.requestFocus(),"original WebView takes Android keyboard focus");pump();HostWindowManager.input(HostInput.key(KeyEvent.ACTION_DOWN,KeyEvent.KEYCODE_A,'a',0));HostWindowManager.input(HostInput.key(KeyEvent.ACTION_UP,KeyEvent.KEYCODE_A,'a',0));long keyDeadline=System.nanoTime()+3_000_000_000L;do{pump();result[0]=null;browser.evaluateJavascript("JSON.stringify(window.keys)",value->result[0]=value);until(()->result[0]!=null,"DOM keyboard result");if(result[0].contains("a"))break;Thread.sleep(5);}while(System.nanoTime()<keyDeadline);check(result[0].contains("a"),"Android keyboard event reaches the browser document: "+result[0]);inspectNative();
            result[0]=null;browser.evaluateJavascript("window.network='pending';fetch("+org.json.JSONObject.quote(networkUrl)+").then(()=>window.network='allowed',()=>window.network='blocked');true",value->result[0]=value);until(()->result[0]!=null,"network request was scheduled");
            String expected=networkAllowed?"\"allowed\"":"\"blocked\"";long end=System.nanoTime()+8_000_000_000L;while(!expected.equals(result[0])&&System.nanoTime()<end){result[0]=null;browser.evaluateJavascript("window.network",value->result[0]=value);until(()->result[0]!=null,"network state callback");for(int i=0;i<20;i++){pump();Thread.sleep(2);}}check(expected.equals(result[0]),"actual embedded browser network policy: "+result[0]);
            System.out.println("PASS actual WebKit pixels, trusted click, JavaScript bridge and network policy "+networkAllowed);
            loaded[0]=false;String asset="file:///android_asset/page.html";browser.loadUrl(asset);until(()->loaded[0],"APK asset navigation completed");check(asset.equals(browser.getUrl())&&asset.equals(browser.getOriginalUrl())&&!navigations.contains(asset),"Android asset URL is retained without an override callback for the application's load");check(asset.equals(browser.copyBackForwardList().getCurrentItem().getUrl()),"Android asset URL is retained in history");
            System.out.println("PASS Android asset URL callbacks and history");
            activateNative();result[0]=null;long visibilityDeadline=System.nanoTime()+3_000_000_000L;do{pump();result[0]=null;browser.evaluateJavascript("document.visibilityState",value->result[0]=value);until(()->result[0]!=null,"page visibility callback");if("\"visible\"".equals(result[0]))break;Thread.sleep(5);}while(System.nanoTime()<visibilityDeadline);check("\"visible\"".equals(result[0]),"location request has a visible native window: "+result[0]);
            result[0]=null;browser.evaluateJavascript("window.locationResult='pending';navigator.geolocation.getCurrentPosition(()=>window.locationResult='unexpected-device-location',()=>window.locationResult='denied');true",value->result[0]=value);until(()->result[0]!=null,"page location request dispatched");
            end=System.nanoTime()+5_000_000_000L;while(!"\"denied\"".equals(result[0])&&System.nanoTime()<end){result[0]=null;browser.evaluateJavascript("window.locationResult",value->result[0]=value);until(()->result[0]!=null,"location denial callback");for(int i=0;i<10;i++){pump();Thread.sleep(2);}}if(!"\"denied\"".equals(result[0])){String state=result[0];result[0]=null;browser.evaluateJavascript("JSON.stringify({visibility:document.visibilityState,focused:document.hasFocus(),secure:isSecureContext})",value->result[0]=value);until(()->result[0]!=null,"page visibility diagnostic");throw new AssertionError("WebKit automatic location denial state="+state+" page="+result[0]);}
            browser.destroy();System.out.println("PASS original WebView, actual WebKit pixels, trusted click and annotated JavaScript bridge");
        }catch(Throwable error){first=error;throw error;}finally{try{try{if(!activity.isDestroyed())HostActivity.finish(activity);}finally{HostWindowManager.shutdown();if(output!=null)output.release();HostApplication.shutdown();session.stopCallbacks(()->HostLooper.drain(loop));session.close();HostDisplayEvents.hostShutdown();HostDisplay.hostShutdown();HostDisplay.hostRemove();HostContext.hostShutdown();FrameworkResources.shutdown();HostLooper.close(loop);WindowSession.shutdownApplication();}}catch(Throwable cleanup){if(first!=null)first.addSuppressed(cleanup);else throw cleanup;}}
    }
}
