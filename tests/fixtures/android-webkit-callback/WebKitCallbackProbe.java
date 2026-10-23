import android.webkit.*;
import java.lang.reflect.*;
import java.util.*;
import maclauncher.android.web.WebKitView;
import maclauncher.android.web.WebKitNative;

public final class WebKitCallbackProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static Field field(String name)throws Exception{Field value=WebKitView.class.getDeclaredField(name);value.setAccessible(true);return value;}
    static void call(WebKitView adapter,String name,Class<?>[] types,Object... values)throws Throwable{adapter.invoke(null,WebViewProvider.class.getMethod(name,types),values);}
    public static void main(String[] args)throws Throwable{
        Class<?> unsafe=Class.forName("sun.misc.Unsafe");Field singleton=unsafe.getDeclaredField("theUnsafe");singleton.setAccessible(true);
        WebKitView adapter=(WebKitView)unsafe.getMethod("allocateInstance",Class.class).invoke(singleton.get(null),WebKitView.class);
        List<String> errors=new ArrayList<>(),titles=new ArrayList<>();
        field("client").set(adapter,new WebViewClient(){
            @Override public void onReceivedError(WebView view,int code,String description,String failingUrl){
                // The original Kotlin client rejects this same null argument.
                errors.add(Objects.requireNonNull(failingUrl,"failingUrl"));
                check(code==ERROR_UNKNOWN,"error code changed");
            }
        });
        field("chrome").set(adapter,new WebChromeClient(){@Override public void onReceivedTitle(WebView view,String title){titles.add(title);}});
        adapter.navigation("error",null,"early navigation failure",0);
        check(errors.getLast().equals("about:blank"),"early failure has no document URL");
        adapter.navigation("finished","https://committed.example/","Committed page",100);titles.clear();
        call(adapter,"loadUrl",new Class<?>[]{String.class},"https://first.example/");
        adapter.navigation("error",null,"provisional failure",0);
        check(errors.getLast().equals("https://first.example/"),"new provisional failure cannot report the stale committed URL");
        call(adapter,"loadData",new Class<?>[]{String.class,String.class,String.class},"<p>inline</p>","text/html","UTF-8");
        check(WebKitNative.lastBase.equals("about:blank"),"inline HTML uses the browser default origin");
        adapter.navigation("error",null,"inline failure",0);
        check(errors.getLast().equals("about:blank"),"inline HTML cannot inherit the prior URL");
        Class<?>[] baseTypes={String.class,String.class,String.class,String.class,String.class};
        call(adapter,"loadDataWithBaseURL",baseTypes,"https://base.example/assets/","<p>base</p>","text/html","UTF-8",null);
        check(WebKitNative.lastBase.equals("https://base.example/assets/"),"actual HTML base URL changed");
        call(adapter,"reload",new Class<?>[0]);adapter.navigation("error",null,"reload failure",0);
        check(WebKitNative.reloads==1&&errors.getLast().equals("https://base.example/assets/"),"reload retains the actual base URL");
        adapter.navigation("started","https://redirect.example/",null,10);
        adapter.navigation("error",null,"redirect failure without native URL",25);
        check(errors.getLast().equals("https://redirect.example/"),"missing native error URL retains the actual redirect target");
        adapter.navigation("error","https://failed.example/redirect","redirect failure",25);
        check(errors.getLast().equals("https://failed.example/redirect"),"original native error URL wins over fallback state");
        call(adapter,"loadDataWithBaseURL",baseTypes,null,"<p>null base</p>","text/html","UTF-8",null);
        adapter.navigation("error",null,"null-base failure",0);
        check(WebKitNative.lastBase.equals("about:blank")&&errors.getLast().equals("about:blank"),"null HTML base defaults to about:blank");
        call(adapter,"loadDataWithBaseURL",baseTypes,"","<p>empty base</p>","text/html","UTF-8",null);
        adapter.navigation("error",null,"empty-base failure",0);
        check(WebKitNative.lastBase.equals("about:blank")&&errors.getLast().equals("about:blank"),"empty HTML base defaults to about:blank");
        field("originalUrl").set(adapter,null);field("navigationUrl").set(adapter,null);field("url").set(adapter,"https://restored.example/");
        adapter.navigation("error",null,"restored failure",0);
        check(errors.getLast().equals("https://restored.example/"),"restored document URL remains available");
        check(titles.isEmpty(),"error descriptions must not become document titles");
        int count=errors.size();field("closed").setBoolean(adapter,true);adapter.navigation("error",null,"late failure",0);
        check(errors.size()==count,"closed browsers ignore late callbacks");
        System.out.println("PASS nonnull WebView errors for early navigation, inline HTML, base URLs, reload, redirect and restored documents");
    }
}
