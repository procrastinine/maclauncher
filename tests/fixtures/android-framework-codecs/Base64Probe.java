import android.util.Base64;
import android.util.Base64InputStream;
import android.util.Base64OutputStream;
import android.util.Base64DataException;
import java.io.*;
import java.util.*;
import java.nio.charset.StandardCharsets;

public final class Base64Probe {
    static int checks;
    static void check(boolean value){checks++;if(!value)throw new AssertionError("check "+checks);}
    static void equal(byte[] a,byte[] b){check(Arrays.equals(a,b));}
    interface Action{void run()throws Exception;}
    static Throwable fails(Class<? extends Throwable> type,Action action)throws Exception{try{action.run();throw new AssertionError("expected "+type);}catch(Throwable e){if(!type.isInstance(e))throw e;checks++;return e;}}
    static byte[] expected(byte[] input,int flags){
        java.util.Base64.Encoder codec=(flags&Base64.URL_SAFE)!=0?java.util.Base64.getUrlEncoder():java.util.Base64.getEncoder();
        if((flags&Base64.NO_PADDING)!=0)codec=codec.withoutPadding();
        String value=codec.encodeToString(input);
        if((flags&Base64.NO_WRAP)!=0||value.isEmpty())return value.getBytes(StandardCharsets.US_ASCII);
        String newline=(flags&Base64.CRLF)!=0?"\r\n":"\n";var result=new StringBuilder();
        for(int at=0;at<value.length();at+=76)result.append(value,at,Math.min(value.length(),at+76)).append(newline);
        return result.toString().getBytes(StandardCharsets.US_ASCII);
    }
    static final class Sink extends ByteArrayOutputStream {int closes,flushes;public void close(){closes++;}public void flush(){flushes++;}}
    static final class ShortInput extends ByteArrayInputStream {final int chunk;boolean zero;int closes;ShortInput(byte[] b,int chunk,boolean zero){super(b);this.chunk=chunk;this.zero=zero;}public synchronized int read(byte[] b,int off,int len){if(zero){zero=false;return 0;}return super.read(b,off,Math.min(chunk,len));}public void close(){closes++;}}
    static byte[] output(byte[] bytes,int flags,boolean encode,boolean single)throws Exception{
        var sink=new Sink();var out=new Base64OutputStream(sink,flags,encode);
        if(single){for(byte b:bytes)out.write(b);}else{int at=0;while(at<bytes.length){int n=Math.min(bytes.length-at,1+(at*31)%97);out.write(bytes,at,n);at+=n;}}
        out.close();check(sink.closes==((flags&Base64.NO_CLOSE)==0?1:0));check(sink.flushes==((flags&Base64.NO_CLOSE)!=0?1:0));byte[] finished=sink.toByteArray();out.close();if(!Arrays.equals(sink.toByteArray(),finished))throw new AssertionError("repeat close flags="+flags+" input="+bytes.length+" encode="+encode+" before="+finished.length+" after="+sink.size());checks++;return finished;
    }
    static byte[] input(byte[] bytes,int flags,boolean encode,int chunk)throws Exception{
        var source=new ShortInput(bytes,chunk,chunk==1);var in=new Base64InputStream(source,flags,encode);check(in.available()==0&&!in.markSupported());var result=new ByteArrayOutputStream();byte[] buffer=new byte[113];int n;
        while((n=in.read(buffer))!=-1){check(n>0);result.write(buffer,0,n);}check(in.read()==-1);in.close();check(source.closes==1);return result.toByteArray();
    }
    public static void main(String[] args)throws Exception{
        var random=new Random(7051);
        for(int flags=0;flags<32;flags++)for(int length=0;length<=256;length++){
            byte[] value=new byte[length];random.nextBytes(value);byte[] encoded=expected(value,flags);
            equal(Base64.encode(value,flags),encoded);equal(Base64.decode(encoded,flags),value);
            check(Base64.encodeToString(value,flags).equals(new String(encoded,StandardCharsets.US_ASCII)));
            equal(Base64.decode(new String(encoded,StandardCharsets.US_ASCII),flags),value);
            byte[] offset=new byte[length+6];System.arraycopy(value,0,offset,3,length);equal(Base64.encode(offset,3,length,flags),encoded);
        }
        for(int flags=0;flags<32;flags++)for(int length:new int[]{0,1,2,3,57,58,127,1024,2047,2048,2049,65537}){
            byte[] value=new byte[length];random.nextBytes(value);byte[] encoded=expected(value,flags);
            byte[] actualOutput=output(value,flags,true,length<2050);if(!Arrays.equals(actualOutput,encoded))throw new AssertionError("output flags="+flags+" length="+length+" got="+new String(actualOutput,StandardCharsets.US_ASCII)+" expected="+new String(encoded,StandardCharsets.US_ASCII));checks++;equal(output(encoded,flags,false,length<2050),value);
            equal(input(encoded,flags,false,length<2050?1:17),value);equal(input(value,flags,true,length<2050?2:31),encoded);
        }
        for(String invalid:new String[]{"A","=AAA","AA=A","AAA==","AAAA=","AA==A"}){
            byte[] data=invalid.getBytes(StandardCharsets.US_ASCII);
            fails(IllegalArgumentException.class,()->Base64.decode(data,0));
            fails(Base64DataException.class,()->{try(var in=new Base64InputStream(new ShortInput(data,1,false),0)){in.readAllBytes();}});
            var sink=new Sink();var out=new Base64OutputStream(sink,0,false);for(byte b:data)out.write(b);
            fails(Base64DataException.class,out::close);check(sink.closes==1);
        }
        equal(Base64.decode(" ! Z m\n9\tv \r",0),"foo".getBytes(StandardCharsets.US_ASCII));
        equal(input(" ! Z m\n9\tv \r".getBytes(StandardCharsets.US_ASCII),0,false,1),"foo".getBytes(StandardCharsets.US_ASCII));
        var sink=new Sink();var out=new Base64OutputStream(sink,0);out.write('f');out.flush();check(sink.size()==0&&sink.flushes==1);out.close();check(sink.toString(StandardCharsets.US_ASCII).equals("Zg==\n"));
        var in=new Base64InputStream(new ByteArrayInputStream("Zm9vYmFy".getBytes(StandardCharsets.US_ASCII)),0);fails(UnsupportedOperationException.class,()->in.mark(10));fails(UnsupportedOperationException.class,in::reset);check(in.read()=='f');check(in.skip(2)==2);check(in.read()=='b');in.close();
        IOException sourceFailure=new IOException("source failure");InputStream broken=new InputStream(){public int read()throws IOException{throw sourceFailure;}};check(fails(IOException.class,()->new Base64InputStream(broken,0).read())==sourceFailure);
        IOException writeFailure=new IOException("write"),closeFailure=new IOException("close");OutputStream brokenOut=new OutputStream(){public void write(int b)throws IOException{throw writeFailure;}public void close()throws IOException{throw closeFailure;}};var both=new Base64OutputStream(brokenOut,0);both.write(1);check(fails(IOException.class,both::close)==writeFailure);check(Arrays.equals(writeFailure.getSuppressed(),new Throwable[]{closeFailure}));
        OutputNegative.main(new String[]{"same-error"});OutputNegative.main(new String[]{"memory"});StreamNegative.main(new String[0]);CloseNegative.main(new String[0]);FinishNegative.main(new String[0]);
        var retired=new Base64OutputStream(OutputStream.nullOutputStream(),0);retired.close();fails(IOException.class,()->retired.write(1));fails(IOException.class,()->retired.write(new byte[]{1}));
        for(String mode:new String[]{"zero","skip","write"})InputEdgesNegative.main(new String[]{mode});
        var empty=new Base64InputStream(new ByteArrayInputStream(new byte[0]),0);check(empty.read()==-1);check(empty.read(new byte[0],0,0)==0);fails(NullPointerException.class,()->empty.read(null,0,0));fails(IndexOutOfBoundsException.class,()->empty.read(new byte[1],-1,0));empty.close();empty.close();fails(IOException.class,empty::read);fails(IOException.class,empty::available);
        IOException closeInputFailure=new IOException("input close");int[] closeCalls={0};InputStream failingClose=new ByteArrayInputStream(new byte[0]){public void close()throws IOException{closeCalls[0]++;throw closeInputFailure;}};var closing=new Base64InputStream(failingClose,0);check(fails(IOException.class,closing::close)==closeInputFailure);closing.close();check(closeCalls[0]==1);fails(IOException.class,closing::read);
        final long[] count={0};OutputStream counting=new OutputStream(){public void write(int b){count[0]++;}public void write(byte[] b,int off,int len){count[0]+=len;}};byte[] block=new byte[1<<20];var large=new Base64OutputStream(counting,Base64.NO_WRAP);for(int i=0;i<64;i++)large.write(block);large.close();check(count[0]==4*((64L*block.length+2)/3));
        check(Base64DataException.class.getSuperclass()==IOException.class);check(new Base64DataException("detail").getMessage().equals("detail"));
        System.out.println("PASS Base64 flags, independent bytes, streaming chunks, short input, close failures and64MiB bounded streaming "+checks);
    }
}
