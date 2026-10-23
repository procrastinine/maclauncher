package maclauncher.android;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Tests the physical bootstrap channel before any Android classes are loaded. */
final class ProcessAuthority {
    private record Packet(byte[] bytes,int fd) {}
    private static native void sendFixture(int fd,byte[] bytes);
    private static native Packet receiveNative(int fd)throws IOException;
    private static native void closeFixture(int fd);
    private static native int[] pair();
    private static native void echo(int fd,byte[] expected);
    private static native boolean closed(int fd);
    public static void main(String[] args)throws Exception {
        System.load(args[0]);int[] pair=pair();
        byte[] hello="{\"op\":\"process-identity\",\"pid\":123,\"hostPid\":456}".getBytes(StandardCharsets.UTF_8);
        try {
            sendFixture(pair[1],new byte[0]);
            try{receiveNative(pair[0]);throw new AssertionError("Empty bootstrap accepted");}catch(IOException expected){}
            if(closed(pair[0]))throw new AssertionError("Failure closed caller descriptor");
            sendFixture(pair[0],hello);echo(pair[1],hello);
            Packet result=receiveNative(pair[0]);
            if(result.fd()!=-1||!Arrays.equals(hello,result.bytes()))throw new AssertionError("Bootstrap framing differs");
        }finally{closeFixture(pair[0]);closeFixture(pair[1]);}
        if(!closed(pair[0])||!closed(pair[1]))throw new AssertionError("Descriptor owner was retained");
        System.out.println("PASS supervisor bootstrap without Android initialization");
    }
}
