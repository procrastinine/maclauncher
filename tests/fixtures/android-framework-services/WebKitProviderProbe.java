package maclauncher.android.web;

import java.nio.file.*;
import android.os.Looper;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.HostLooper;

/** Provider metadata uses the selected runtime, regardless of VM code origins. */
public final class WebKitProviderProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),data=Path.of(args[1]),source=Path.of(args[2]);
        Looper loop=RuntimeFixture.initialize(runtime.toString(),data.toString());
        try{
            // Only the unrelated physical WebKit version query is supplied by
            // the fixture. Configuration and original PackageInfo are real.
            var version=WebKitFactory.class.getDeclaredField("version");version.setAccessible(true);version.set(null,"620.1.16");
            Path browser=data.resolve("files/webview");
            WebKitFactory.configure(browser,false,source);
            var info=WebKitFactory.packageInfo();
            check(info.packageName.equals("maclauncher.android.webkit"),"provider package identity");
            check(info.applicationInfo.packageName.equals(info.packageName),"original application identity");
            check(info.applicationInfo.uid==android.os.Process.myUid(),"provider UID");
            check(info.versionName.equals("620.1.16")&&info.getLongVersionCode()==620001016L,"provider version");
            check(info.applicationInfo.sourceDir.equals(source.toAbsolutePath().normalize().toString()),"explicit runtime source");
            check(info.applicationInfo.publicSourceDir.equals(info.applicationInfo.sourceDir),"public source identity");
            check(info.applicationInfo.dataDir.equals(browser.toAbsolutePath().toString()),"private browser storage");
            check(WebKitFactory.providerClass()==WebKitFactory.class,"same original provider selection");
            check(android.webkit.WebView.getCurrentWebViewPackage().applicationInfo.sourceDir.equals(info.applicationInfo.sourceDir),"original WebView package discovery");
            WebKitFactory.configure(browser,false,source);
            try{WebKitFactory.configure(browser,false,source.resolveSibling("another-provider.jar"));throw new AssertionError("mutable provider origin");}catch(IllegalStateException expected){}
            try{WebKitFactory.configure(browser,true,source);throw new AssertionError("mutable network policy");}catch(IllegalStateException expected){}
            System.out.println("PASS explicit WebKit provider origin, original package discovery and immutable application scope");
        }finally{HostLooper.close(loop);}
    }
}
