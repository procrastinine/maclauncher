import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.impl.client.DefaultHttpClient;
import org.apache.http.util.EntityUtils;

public final class LegacyHttpProbe {
    private static void check(boolean okay){if(!okay)throw new AssertionError();}
    public static void main(String[] args)throws Exception {
        var runtime=java.nio.file.Path.of(args[0]).toAbsolutePath();
        System.load(runtime.resolve("native/libklepton-jvm.dylib").toString());
        System.load(runtime.resolve("native/libnativebinding.dylib").toString());
        // The whole Android module supplies real parsing, encoding and transport.
        check(new String(org.apache.commons.codec.binary.Base64.decodeBase64("YW5kcm9pZA==".getBytes(StandardCharsets.US_ASCII)),StandardCharsets.UTF_8).equals("android"));
        var headers=org.apache.http.message.BasicHeaderValueParser.parseElements("a=one; p=two, b=three",null);
        check(headers.length==2&&headers[0].getParameterByName("p").getValue().equals("two"));
        check(new android.net.compatibility.WebAddress("localhost:8080/path").getPort()==8080);
        var form=new org.apache.http.client.entity.UrlEncodedFormEntity(List.of(new org.apache.http.message.BasicNameValuePair("a b","c+d")),"UTF-8");
        check(EntityUtils.toString(form).equals("a+b=c%2Bd"));
        Class.forName("android.net.http.AndroidHttpClient",false,LegacyHttpProbe.class.getClassLoader());
        Class.forName("com.android.internal.http.multipart.MultipartEntity",false,LegacyHttpProbe.class.getClassLoader());
        var failure=new AtomicReference<Throwable>();
        try(var server=new ServerSocket(0,1,InetAddress.getLoopbackAddress())){
            server.setSoTimeout(5000);
            Thread worker=new Thread(()->{try(var socket=server.accept()){
                socket.setSoTimeout(5000);var input=socket.getInputStream();int state=0;
                while(state<4){int value=input.read();if(value<0)throw new java.io.EOFException();state=value==((state&1)==0?'\r':'\n')?state+1:0;}
                socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\nSet-Cookie: owner=module; Path=/\r\nConnection: close\r\n\r\n6\r\nlegacy\r\n0\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            }catch(Throwable error){failure.set(error);}},"legacy-http-local-server");worker.setDaemon(true);worker.start();
            var client=new DefaultHttpClient();
            org.apache.http.params.HttpConnectionParams.setConnectionTimeout(client.getParams(),3000);
            org.apache.http.params.HttpConnectionParams.setSoTimeout(client.getParams(),3000);
            try{
                var response=client.execute(new HttpGet("http://127.0.0.1:"+server.getLocalPort()+"/request"));
                check(response.getStatusLine().getStatusCode()==200&&EntityUtils.toString(response.getEntity()).equals("legacy"));
                check(client.getCookieStore().getCookies().stream().anyMatch(cookie->cookie.getName().equals("owner")&&cookie.getValue().equals("module")));
            }finally{client.getConnectionManager().shutdown();}
            worker.join(6000);check(!worker.isAlive());if(failure.get()!=null)throw new AssertionError(failure.get());
        }
        System.out.println("PASS complete Android legacy HTTP module, local chunked response, cookies, codecs and Android helpers");
    }
}
