package maclauncher.android.media;

import android.media.MediaCodec;
import android.media.MediaDataSource;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.os.Looper;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import maclauncher.android.fixture.MediaServicesFixture;
import maclauncher.android.framework.HostLooper;

/** Actual full-framework extractor against the four-frame AVFoundation movie. */
public final class MediaExtractorProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static final byte GUARD=(byte)0x5a;
    private static final class Source extends MediaDataSource {
        final byte[] bytes;
        final boolean broken;
        final AtomicInteger reads=new AtomicInteger(),closes=new AtomicInteger();
        final CountDownLatch closed=new CountDownLatch(1);
        Source(byte[] value,boolean fail){bytes=value;broken=fail;}
        @Override public int readAt(long position,byte[] buffer,int offset,int size)throws IOException {
            check(closes.get()==0,"Java callback invoked after close");reads.incrementAndGet();
            if(broken)throw new IOException("Fixture source read failed");
            if(size==0)return 0;
            if(position>=bytes.length)return -1;
            if(position<0)throw new IOException("Negative position");
            int count=(int)Math.min(size,bytes.length-position);
            System.arraycopy(bytes,(int)position,buffer,offset,count);return count;
        }
        @Override public long getSize(){check(closes.get()==0,"Size callback after close");return bytes.length;}
        @Override public void close(){closes.incrementAndGet();closed.countDown();}
        void expectClosed()throws InterruptedException {
            check(closed.await(5,TimeUnit.SECONDS),"Callback source was not closed");
            check(closes.get()==1,"Callback source close must happen exactly once");
        }
    }
    private static byte[] copy(ByteBuffer buffer){
        ByteBuffer view=buffer.duplicate();byte[] bytes=new byte[view.remaining()];view.get(bytes);return bytes;
    }
    private static byte[] current(MediaExtractor extractor){
        long size=extractor.getSampleSize();check(size>0&&size<=Integer.MAX_VALUE-8,"Actual sample size");
        ByteBuffer direct=ByteBuffer.allocateDirect((int)size+8);
        int count=extractor.readSampleData(direct,3);
        check(count==size&&direct.position()==3&&direct.limit()==count+3,"Direct buffer range follows original JNI contract");
        return copy(direct);
    }
    private static byte[] exercise(MediaExtractor extractor){
        check(extractor.getTrackCount()==1,"Generated movie has one track");
        MediaFormat format=extractor.getTrackFormat(0);
        check("video/avc".equals(format.getString(MediaFormat.KEY_MIME)),"Actual H.264 MIME");
        check(format.getInteger(MediaFormat.KEY_WIDTH)==32&&format.getInteger(MediaFormat.KEY_HEIGHT)==32,"Actual coded dimensions");
        check(format.getLong(MediaFormat.KEY_DURATION)>0,"Actual track duration");
        check(extractor.getAudioPresentations(0).isEmpty(),"Plain video has no audio presentations");
        check(extractor.getPsshInfo()==null,"Clear generated movie has no PSSH");
        check(extractor.getMetrics().getInt(MediaExtractor.MetricsConstants.TRACKS)==1,"Actual track metric");
        check(extractor.getSampleTrackIndex()==-1,"No sample before selecting a track");
        extractor.selectTrack(0);extractor.selectTrack(0);
        check(extractor.getSampleTrackIndex()==0,"Selection identifies the actual track");
        check((extractor.getSampleFlags()&MediaExtractor.SAMPLE_FLAG_SYNC)!=0,"First sample is a sync frame");
        check(!extractor.getSampleCryptoInfo(new MediaCodec.CryptoInfo()),"Unencrypted sample has no crypto information");
        long firstTime=extractor.getSampleTime();byte[] first=current(extractor);

        // A heap slice has a nonzero arrayOffset, and the caller's old limit is
        // unrelated to the explicit extraction offset/capacity contract.
        byte[] backing=new byte[first.length+64];Arrays.fill(backing,GUARD);
        ByteBuffer root=ByteBuffer.wrap(backing);root.position(13);root.limit(13+first.length+20);
        ByteBuffer slice=root.slice();slice.limit(3);
        int copied=extractor.readSampleData(slice,7);
        check(copied==first.length&&slice.position()==7&&slice.limit()==7+copied,"Heap slice range");
        check(Arrays.equals(copy(slice),first),"Heap/direct samples match without advancing");
        for(int i=0;i<backing.length;i++)if(i<20||i>=20+copied)check(backing[i]==GUARD,"Heap slice wrote outside its sample range");
        try {extractor.readSampleData(ByteBuffer.allocate(first.length-1),0);throw new AssertionError("Small destination accepted");}
        catch(IllegalArgumentException expected){}
        check(extractor.getSampleTime()==firstTime&&extractor.getSampleSize()==first.length,"Failed read did not advance sample");
        try {extractor.readSampleData(ByteBuffer.allocateDirect(first.length).asReadOnlyBuffer(),0);throw new AssertionError("Read-only destination accepted");}
        catch(IllegalArgumentException expected){}

        ByteBuffer retained=format.getByteBuffer("csd-0");check(retained!=null,"Actual codec initialization bytes");
        byte[] initialization=copy(retained);
        int samples=1;
        while(extractor.advance()){
            check(samples<4,"Extractor failed to reach EOS");
            check(extractor.getSampleTrackIndex()==0&&current(extractor).length>0,"Readable selected sample");++samples;
        }
        check(samples==4,"All four actual samples observed");
        check(extractor.getSampleTrackIndex()==-1&&extractor.getSampleTime()==-1&&extractor.getSampleSize()==-1&&extractor.getSampleFlags()==-1,"EOS sample metadata");
        check(extractor.readSampleData(ByteBuffer.allocateDirect(1024),0)==-1&&!extractor.advance(),"EOS is stable");
        check(Arrays.equals(copy(slice),first),"Later native samples did not replace returned Java sample bytes");
        extractor.seekTo(0,MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
        check(extractor.getSampleTime()==firstTime&&Arrays.equals(current(extractor),first),"Seek restores the first real sync sample");
        extractor.unselectTrack(0);check(extractor.getSampleTrackIndex()==-1,"Unselection removes sample visibility");
        extractor.selectTrack(0);extractor.seekTo(0,MediaExtractor.SEEK_TO_CLOSEST_SYNC);
        check(Arrays.equals(current(extractor),first),"Reselection can seek and read again");
        extractor.release();extractor.release();
        check(Arrays.equals(copy(retained),initialization),"Returned format buffers own their bytes after release");
        try {extractor.getTrackCount();throw new AssertionError("Released extractor accepted a call");}
        catch(IllegalStateException expected){}
        return first;
    }
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]).toRealPath(),data=Files.createDirectories(Path.of(args[1])),movie=Path.of(args[2]);
        try (MediaServicesFixture services=new MediaServicesFixture(runtime,data)) {
            Looper loop=services.loop;
            byte[] media=Files.readAllBytes(movie);
            MediaExtractor path=new MediaExtractor();byte[] expected;
            try {path.setDataSource(movie.toAbsolutePath().toString());expected=exercise(path);}finally{path.release();}

            Source callback=new Source(media,false);MediaExtractor custom=new MediaExtractor();
            try {
                custom.setDataSource(callback);check(callback.closes.get()==0,"Source remains open while extractor owns it");
                check(Arrays.equals(exercise(custom),expected),"Callback source matches original local file");
            }finally{custom.release();}
            callback.expectClosed();check(callback.reads.get()>0,"Original MediaDataSource.readAt was invoked");

            byte[] bytes=new byte[media.length+59];Arrays.fill(bytes,GUARD);System.arraycopy(media,0,bytes,37,media.length);
            Path ranged=data.resolve("ranged-movie.bin");Files.write(ranged,bytes);
            MediaExtractor descriptor=new MediaExtractor();
            try {
                try(FileInputStream input=new FileInputStream(ranged.toFile())){descriptor.setDataSource(input.getFD(),37,media.length);}
                Files.delete(ranged);
                check(Arrays.equals(exercise(descriptor),expected),"Closed/unlinked ranged FD retains the exact movie");
            }finally{descriptor.release();}

            Source broken=new Source(media,true);MediaExtractor failed=new MediaExtractor();
            try {
                try {failed.setDataSource(broken);throw new AssertionError("Thrown callback read was treated as valid EOF");}
                catch(IOException expectedFailure){}
            }finally{failed.release();}
            broken.expectClosed();
            System.out.println("PASS original MediaExtractor metadata, heap slices, direct buffers, seek, EOS, FD ranges and callback ownership");
        }
    }
}
