package maclauncher.android.web;

/** CPU-only boundary for invoking the real Android provider without WebKit. */
public final class WebKitNative {
    public static String lastBase;
    public static int reloads;
    static void html(long handle,String html,String baseUrl){lastBase=baseUrl;}
    static void load(long handle,String url,String[] headers,String[] values,byte[] body){}
    static void reload(long handle){reloads++;}
}
