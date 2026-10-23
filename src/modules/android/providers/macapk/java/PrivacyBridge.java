package com.maclauncher.android.macapk;

import java.awt.datatransfer.*;
import java.net.*;
import java.nio.*;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.locks.LockSupport;

/** Private clipboard storage; only the external gesture broker touches macOS. */
public final class PrivacyBridge {
    private static final int LIMIT=1024*1024;
    private static final Clipboard CLIPBOARD=new Clipboard("Android application") {
        @Override public synchronized Transferable getContents(Object requestor) {
            String text=exchange("paste",null);
            if(text!=null)super.setContents(new StringSelection(text),null);
            return super.getContents(requestor);
        }
        @Override public synchronized void setContents(Transferable contents,ClipboardOwner owner) {
            super.setContents(contents,owner);
            try {if(contents!=null&&contents.isDataFlavorSupported(DataFlavor.stringFlavor))exchange("copy",String.valueOf(contents.getTransferData(DataFlavor.stringFlavor)));}
            catch(Exception ignored) {}
        }
    };
    public static Clipboard clipboard(){return CLIPBOARD;}
    public static String fingerprint(String release,String incremental){return "google/tangorpro/tangorpro:"+release+"/ML1/"+incremental+":user/release-keys";}
    public static void properties(Map<String,String> values){
        values.put("ro.product.brand","google");values.put("ro.product.manufacturer","Google");
        values.put("ro.product.model","Pixel Tablet");values.put("ro.product.name","tangorpro");
        values.put("ro.product.device","tangorpro");values.put("ro.product.board","tangorpro");
        values.put("ro.hardware","tangorpro");values.put("ro.build.id","ML1");
        values.put("ro.build.display.id","MacLauncher Pixel Tablet");
        values.put("ro.build.host","android-build");values.put("ro.build.user","android-build");
        String fp=fingerprint(values.get("ro.build.version.release"),values.get("ro.build.version.incremental"));
        values.put("ro.build.fingerprint",fp);values.put("ro.system.build.fingerprint",fp);
        values.put("ro.sf.lcd_density","320");
    }
    private static String exchange(String operation,String text){
        String endpoint=System.getenv("MACLAUNCHER_CLIPBOARD_SOCKET");
        if(endpoint==null||endpoint.isEmpty()||text!=null&&text.getBytes(StandardCharsets.UTF_8).length>LIMIT-128)return null;
        long deadline=System.nanoTime()+2_000_000_000L;
        try(SocketChannel socket=SocketChannel.open(StandardProtocolFamily.UNIX)){
            socket.configureBlocking(false);socket.connect(UnixDomainSocketAddress.of(endpoint));
            while(!socket.finishConnect())pause(deadline);
            String request="{\"operation\":\""+operation+"\""+(text==null?"":",\"text\":"+quote(text))+"}\n";
            ByteBuffer output=StandardCharsets.UTF_8.encode(request);
            while(output.hasRemaining()){if(socket.write(output)==0)pause(deadline);}
            ByteBuffer input=ByteBuffer.allocate(LIMIT);int end=-1;
            while(end<0){int before=input.position(),count=socket.read(input);if(count<0)return null;if(count==0){pause(deadline);continue;}
                for(int i=before;i<input.position();i++)if(input.get(i)=='\n'){end=i;break;}
                if(!input.hasRemaining()&&end<0)return null;
            }
            String reply=new String(input.array(),0,end,StandardCharsets.UTF_8);
            if(!reply.matches("(?s).*\"allowed\"\\s*:\\s*true(?:\\s*[,}]).*"))return null;
            int key=reply.indexOf("\"text\"");if(key<0)return "";
            int at=reply.indexOf(':',key+6)+1;while(at<reply.length()&&Character.isWhitespace(reply.charAt(at)))at++;
            return unquote(reply,at);
        }catch(Exception ignored){return null;}
    }
    private static void pause(long deadline)throws java.io.IOException{
        if(System.nanoTime()>=deadline||Thread.currentThread().isInterrupted())throw new java.io.IOException("Clipboard operation expired");
        LockSupport.parkNanos(1_000_000L);
    }
    private static String quote(String value){StringBuilder out=new StringBuilder("\"");for(char c:value.toCharArray()){
        if(c=='"'||c=='\\')out.append('\\').append(c);else if(c<32)out.append(String.format("\\u%04x",(int)c));else out.append(c);
    }return out.append('"').toString();}
    private static String unquote(String value,int at){
        if(at>=value.length()||value.charAt(at++)!='"')throw new IllegalArgumentException();StringBuilder out=new StringBuilder();
        while(at<value.length()){char c=value.charAt(at++);if(c=='"')return out.toString();if(c!='\\'){out.append(c);continue;}
            c=value.charAt(at++);switch(c){case '"':case '\\':case '/':out.append(c);break;case 'b':out.append('\b');break;case 'f':out.append('\f');break;case 'n':out.append('\n');break;case 'r':out.append('\r');break;case 't':out.append('\t');break;case 'u':out.append((char)Integer.parseInt(value.substring(at,at+4),16));at+=4;break;default:throw new IllegalArgumentException();}}
        throw new IllegalArgumentException();
    }
}
