package com.maclauncher.android.macapk;

import java.net.*;
import java.nio.*;
import java.nio.channels.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.locks.LockSupport;

/** Bounded local JSON transport. No request or response is persisted or logged. */
final class JsonRpc {
    static Map<String,Object> exchange(String endpoint,Map<String,Object> request,int timeout)throws Exception{
        byte[] bytes=(encode(request)+"\n").getBytes(StandardCharsets.UTF_8);
        if(bytes.length>1024*1024)throw new java.io.IOException("Android service request is too large");
        long deadline=System.nanoTime()+timeout*1_000_000L;
        try(SocketChannel socket=SocketChannel.open(StandardProtocolFamily.UNIX)){
            socket.configureBlocking(false);socket.connect(UnixDomainSocketAddress.of(endpoint));while(!socket.finishConnect())pause(deadline);
            ByteBuffer output=ByteBuffer.wrap(bytes);while(output.hasRemaining())if(socket.write(output)==0)pause(deadline);
            ByteBuffer input=ByteBuffer.allocate(1024*1024);int end=-1;
            while(end<0){int before=input.position(),n=socket.read(input);if(n<0)throw new java.io.EOFException();if(n==0){pause(deadline);continue;}
                for(int i=before;i<input.position();i++)if(input.get(i)=='\n'){end=i;break;}if(end<0&&!input.hasRemaining())throw new java.io.IOException("Android service response is too large");}
            Object parsed=new Parser(new String(input.array(),0,end,StandardCharsets.UTF_8)).parse();
            if(!(parsed instanceof Map<?,?>))throw new java.io.IOException("Invalid Android service response");
            @SuppressWarnings("unchecked") Map<String,Object> reply=(Map<String,Object>)parsed;return reply;
        }
    }
    private static void pause(long deadline)throws java.io.IOException{if(System.nanoTime()>=deadline||Thread.currentThread().isInterrupted())throw new java.io.IOException("Android service request expired");LockSupport.parkNanos(1_000_000L);}
    static Object decode(String text){return new Parser(text).parse();}
    static String encode(Object value){
        if(value==null)return "null";if(value instanceof Boolean||value instanceof Number)return value.toString();
        if(value instanceof Map<?,?> map){List<String> pairs=new ArrayList<>();for(var item:map.entrySet())pairs.add(encode(String.valueOf(item.getKey()))+":"+encode(item.getValue()));return "{"+String.join(",",pairs)+"}";}
        if(value instanceof List<?> list){List<String> items=new ArrayList<>();for(Object item:list)items.add(encode(item));return "["+String.join(",",items)+"]";}
        StringBuilder out=new StringBuilder("\"");for(char c:String.valueOf(value).toCharArray()){if(c=='"'||c=='\\')out.append('\\').append(c);else if(c<32)out.append(String.format("\\u%04x",(int)c));else out.append(c);}return out.append('"').toString();
    }
    private static final class Parser{
        final String text;int at;Parser(String text){this.text=text;}
        Object parse(){Object value=value(0);space();if(at!=text.length())throw new IllegalArgumentException();return value;}
        void space(){while(at<text.length()&&Character.isWhitespace(text.charAt(at)))at++;}
        char take(){if(at>=text.length())throw new IllegalArgumentException();return text.charAt(at++);}
        Object value(int depth){if(depth>16)throw new IllegalArgumentException();space();char c=take();
            if(c=='"')return string();
            if(c=='{'){Map<String,Object> out=new LinkedHashMap<>();space();if(at<text.length()&&text.charAt(at)=='}'){at++;return out;}for(;;){space();if(take()!='"')throw new IllegalArgumentException();String key=string();space();if(take()!=':')throw new IllegalArgumentException();if(out.containsKey(key))throw new IllegalArgumentException();out.put(key,value(depth+1));space();char next=take();if(next=='}')return out;if(next!=',')throw new IllegalArgumentException();}}
            if(c=='['){List<Object> out=new ArrayList<>();space();if(at<text.length()&&text.charAt(at)==']'){at++;return out;}for(;;){out.add(value(depth+1));space();char next=take();if(next==']')return out;if(next!=',')throw new IllegalArgumentException();}}
            int start=at-1;while(at<text.length()&&",]} \r\n\t".indexOf(text.charAt(at))<0)at++;String token=text.substring(start,at);return switch(token){case "true"->true;case "false"->false;case "null"->null;default->Double.valueOf(token);};
        }
        String string(){StringBuilder out=new StringBuilder();for(;;){char c=take();if(c=='"')return out.toString();if(c<32)throw new IllegalArgumentException();if(c!='\\'){out.append(c);continue;}c=take();switch(c){case '"':case '\\':case '/':out.append(c);break;case 'b':out.append('\b');break;case 'f':out.append('\f');break;case 'n':out.append('\n');break;case 'r':out.append('\r');break;case 't':out.append('\t');break;case 'u':if(at+4>text.length())throw new IllegalArgumentException();out.append((char)Integer.parseInt(text.substring(at,at+4),16));at+=4;break;default:throw new IllegalArgumentException();}}}
    }
}
