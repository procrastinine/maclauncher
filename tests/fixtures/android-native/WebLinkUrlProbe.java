package maclauncher.android.bridge;

import android.content.Intent;

/** Calls the production parser with string inputs and the JDK's real URI/URL classes. */
public final class WebLinkUrlProbe {
    private static String parse(String value){return WebLinks.url(new Intent("android.intent.action.VIEW",value));}
    private static void accepts(String value,String expected){
        String actual=parse(value);if(!expected.equals(actual))throw new AssertionError(value+" -> "+actual);
    }
    public static void main(String[] args){
        accepts("https://例え.テスト:8443/privacy","https://%E4%BE%8B%E3%81%88.%E3%83%86%E3%82%B9%E3%83%88:8443/privacy");
        accepts("https://bücher.example:443/help","https://b%C3%BCcher.example:443/help");
        accepts("https://[::1]:8443/help","https://[::1]:8443/help");
        accepts("https://example.invalid:65535/path","https://example.invalid:65535/path");
        accepts("https://例え.テスト/path","https://%E4%BE%8B%E3%81%88.%E3%83%86%E3%82%B9%E3%83%88/path");
        for(String invalid:new String[]{"https://例え.テスト:70000/","https://例え.テスト:invalid/","https://例え.テスト:-1/","https://例え.テスト:/","https://[::1]:invalid/","https://user:password@例え.テスト:8443/","https://example.invalid/%0a","https://example.invalid/\\path","file:///private/file"}){
            if(parse(invalid)!=null)throw new AssertionError("Accepted invalid URL: "+invalid);
        }
        System.out.println("PASS JDK web-link parsing preserves international host ports, IPv6 and rejected authorities");
    }
}
