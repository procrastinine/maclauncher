import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import maclauncher.android.bridge.WebLinks;

public final class WebLinksProbe {
    static Intent view(String value){return new Intent(Intent.ACTION_VIEW,Uri.parse(value));}
    static void reject(Intent intent){try{WebLinks.open(intent);throw new AssertionError();}catch(ActivityNotFoundException expected){}}
    public static void main(String[] args)throws Exception{
        maclauncher.android.fixture.RuntimeFixture.initialize(java.nio.file.Path.of(args[0]).getParent().getParent().toString(),args[2]);
        System.load(args[0]);boolean allowed=args[1].equals("allow");WebLinks.hostConfigure(!args[1].equals("deny"));
        for(String value:new String[]{"file:///private/owned", "javascript:alert(1)","https://name:password@example.invalid/", "https://example.invalid/%0a", "https://example.invalid/\\path", "http://example.invalid:70000/", "https://例え.テスト:70000/", "https://例え.テスト:invalid/", "https://例え.テスト:-1/", "https://例え.テスト:/", "https://[::1]:invalid/"}){
            try{reject(view(value));}catch(IllegalArgumentException invalidUri){}
        }
        reject(new Intent("unsupported",Uri.parse("https://example.invalid")));
        if(allowed){
            WebLinks.open(view("https://example.invalid/page?value=one#part"));
            Thread worker=new Thread(()->WebLinks.open(view("https://example.invalid/資料🎮")));worker.start();worker.join();
            WebLinks.open(view("https://example.invalid/package").setPackage("com.android.chrome"));
            WebLinks.open(view("https://example.invalid/component").setClassName("owned.app","owned.Activity"));
            WebLinks.open(view("https://example.invalid/type").setDataAndType(Uri.parse("https://example.invalid/type"),"text/html"));
            WebLinks.open(view("https://example.invalid/category").addCategory("owned.category"));
            WebLinks.open(view("https://例え.テスト:8443/privacy"));
            WebLinks.open(view("https://bücher.example:443/help"));
            WebLinks.open(view("https://[::1]:8443/help"));
        }else WebLinks.open(view("https://example.invalid/"));
        try{WebLinks.hostConfigure(true);throw new AssertionError();}catch(IllegalStateException expected){}
        WebLinks.hostShutdown();WebLinks.hostShutdown();WebLinks.open(view("https://example.invalid/"));
        System.out.println("PASS validated web-link framing, policy and retirement");
    }
}
