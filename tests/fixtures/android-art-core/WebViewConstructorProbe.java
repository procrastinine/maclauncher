package fixture.webview;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Original Activity and WebView construction with no network document. */
public final class WebViewConstructorProbe extends Activity {
    private WebView browser;
    private boolean completed;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        boolean[] inline={false};
        runOnUiThread(()->inline[0]=true);
        if(!inline[0])throw new AssertionError("Original Activity owner dispatch was not inline");
        try {
            browser=new WebView(this);
            System.err.println("PASS original WebView constructor on Activity owner");
            browser.getSettings().setJavaScriptEnabled(true);
            browser.setWebViewClient(new WebViewClient(){
                @Override public void onPageFinished(WebView view,String address) {
                    view.evaluateJavascript("1+1",value->{
                        if(!"2".equals(value))throw new AssertionError("Original JavaScript callback: "+value);
                        completed=true;
                        System.err.println("PASS original WebView local document and JavaScript callback");
                        finish();
                    });
                }
            });
            setContentView(browser);
            browser.loadDataWithBaseURL("about:blank","<html><body>Local document</body></html>","text/html","UTF-8",null);
            new Handler(getMainLooper()).postDelayed(()->{
                if(!completed)throw new AssertionError("Original WebView local callback did not complete");
            },10000);
        } catch(RuntimeException|Error failure) {
            System.err.println("Original WebView construction failed:");
            failure.printStackTrace(System.err);
            throw failure;
        }
    }
    @Override public void onDestroy() {
        if(browser!=null){browser.destroy();browser=null;}
        super.onDestroy();
    }
}
