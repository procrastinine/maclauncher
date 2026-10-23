package maclauncher.android.media;

import android.media.MediaCodec;
import android.media.MediaCodecList;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.os.Handler;
import android.os.Looper;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import maclauncher.android.fixture.MediaServicesFixture;
import maclauncher.android.framework.HostLooper;

/** Original Java decoder APIs against the actual four-frame H.264 movie. */
public final class MediaCodecProbe {
    private static native void ndkProbe(String movie, String mediaLibrary);
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
    private record Sample(byte[] bytes, long time, int flags) {}
    private record Clip(MediaFormat format, List<Sample> samples, Set<Long> times, long endTime) {}

    private static Clip readClip(Path movie) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(movie.toAbsolutePath().toString());
            check(extractor.getTrackCount() == 1, "Generated movie has one video track");
            MediaFormat format = extractor.getTrackFormat(0);
            check("video/avc".equals(format.getString(MediaFormat.KEY_MIME)), "Actual H.264 format");
            extractor.selectTrack(0);
            List<Sample> samples = new ArrayList<>();
            Set<Long> times = new HashSet<>();
            int maximum = 0;
            long endTime = 0;
            do {
                long size = extractor.getSampleSize();
                check(size > 0 && size < Integer.MAX_VALUE - 32, "Actual access-unit size");
                ByteBuffer bytes = ByteBuffer.allocateDirect((int) size);
                check(extractor.readSampleData(bytes, 0) == size, "Read complete access unit");
                byte[] copied = new byte[(int) size];
                bytes.get(copied);
                long time = extractor.getSampleTime();
                int flags = (extractor.getSampleFlags() & MediaExtractor.SAMPLE_FLAG_SYNC) != 0
                        ? MediaCodec.BUFFER_FLAG_KEY_FRAME : 0;
                samples.add(new Sample(copied, time, flags));
                times.add(time);
                maximum = Math.max(maximum, copied.length);
                endTime = Math.max(endTime, time + 1);
            } while (extractor.advance());
            check(samples.size() == 4 && times.size() == 4, "Four distinct presentation timestamps");
            check(format.getByteBuffer("csd-0") != null, "Original extractor supplies codec initialization");
            format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, maximum + 32);
            return new Clip(format, samples, times, endTime);
        } finally {
            extractor.release();
        }
    }

    private static void queue(MediaCodec codec, int index, Sample sample) {
        ByteBuffer input = codec.getInputBuffer(index);
        check(input != null && input.isDirect() && !input.isReadOnly(), "Writable direct input buffer");
        check(input.remaining() >= sample.bytes.length, "Input capacity fits the access unit");
        input.put(sample.bytes);
        codec.queueInputBuffer(index, 0, sample.bytes.length, sample.time, sample.flags);
    }

    private static void checkFormat(MediaFormat format) {
        check("video/raw".equals(format.getString(MediaFormat.KEY_MIME)), "Decoded output MIME");
        check(format.getInteger(MediaFormat.KEY_WIDTH) == 32
                && format.getInteger(MediaFormat.KEY_HEIGHT) == 32, "Decoded output dimensions");
    }

    private static boolean output(MediaCodec codec, int index, MediaCodec.BufferInfo info,
                                  Set<Long> times) {
        try {
            boolean eos = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
            if (info.size > 0) {
                ByteBuffer bytes = codec.getOutputBuffer(index);
                check(bytes != null && bytes.isDirect() && bytes.isReadOnly(), "Read-only direct decoded bytes");
                check(bytes.position() == info.offset && bytes.limit() == info.offset + info.size,
                        "Output ByteBuffer exposes the valid frame range");
                check(times.add(info.presentationTimeUs), "A decoded frame was delivered twice");
                boolean nonzero = false;
                while (bytes.hasRemaining()) nonzero |= bytes.get() != 0;
                check(nonzero, "Decoded frame contains actual pixels");
            } else {
                check(eos, "Only EOS may have an empty decoded payload");
            }
            return eos;
        } finally {
            codec.releaseOutputBuffer(index, false);
        }
    }

    private static void decode(MediaCodec codec, Clip clip, boolean independent) {
        int first = codec.dequeueInputBuffer(1_000_000);
        check(first >= 0, "First input slot available");
        int second = -1;
        if (independent) {
            second = codec.dequeueInputBuffer(1_000_000);
            check(second >= 0 && second != first, "Simultaneously leased input slots are distinct");
            ByteBuffer a = codec.getInputBuffer(first), b = codec.getInputBuffer(second);
            check(a != null && b != null && a.capacity() > 0 && b.capacity() > 0, "Both inputs have storage");
            a.put(0, (byte) 0x31);
            b.put(0, (byte) 0x72);
            check(a.get(0) == (byte) 0x31, "Input slots do not alias native storage");
        }
        for (int i = 0; i < clip.samples.size(); i++) {
            int index = i == 0 ? first : i == 1 && independent ? second : codec.dequeueInputBuffer(1_000_000);
            check(index >= 0, "Input slot available for each sample");
            queue(codec, index, clip.samples.get(i));
        }
        int eosInput = codec.dequeueInputBuffer(1_000_000);
        check(eosInput >= 0, "Input slot available for EOS");
        // Empty EOS does not require mapping its input buffer.
        codec.queueInputBuffer(eosInput, 0, 0, clip.endTime, MediaCodec.BUFFER_FLAG_END_OF_STREAM);

        Set<Long> times = new HashSet<>();
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        boolean eos = false;
        int formats = 0;
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!eos && System.nanoTime() < deadline) {
            int index = codec.dequeueOutputBuffer(info, 100_000);
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                checkFormat(codec.getOutputFormat());
                formats++;
            } else if (index == MediaCodec.INFO_TRY_AGAIN_LATER || index == MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED) {
                continue;
            } else {
                check(index >= 0, "Unexpected output status: " + index);
                eos = output(codec, index, info, times);
            }
        }
        check(eos && times.equals(clip.times), "All four frames arrive before decoder EOS");
        if (independent) check(formats > 0, "Initial decoding reports its output format");
    }

    private static String discover(Clip clip) throws Exception {
        MediaCodecList list = new MediaCodecList(MediaCodecList.ALL_CODECS);
        String selected = list.findDecoderForFormat(clip.format);
        check(selected != null, "Original capability matching finds the actual H.264 decoder");
        MediaCodecInfo selectedInfo = null;
        for (MediaCodecInfo info : list.getCodecInfos()) {
            check(!info.isEncoder(), "Only implemented decoder owners are advertised");
            check(info.getName().equals(info.getCanonicalName()), "Canonical discovery name");
            for (String mime : info.getSupportedTypes()) {
                MediaCodecInfo.CodecCapabilities caps = info.getCapabilitiesForType(mime);
                check(caps.profileLevels.length > 0 && caps.colorFormats.length > 0,
                        "Native decoder supplies profiles and actual output layouts");
                check(caps.getVideoCapabilities() != null, "Original Java video capabilities retained");
                MediaCodec named = MediaCodec.createByCodecName(info.getName());
                try {
                    check(named.getCodecInfo().getCanonicalName().equals(info.getCanonicalName()),
                            "Creation and discovery share the same descriptor owner");
                } finally { named.release(); }
            }
            if (selected.equals(info.getName())) selectedInfo = info;
        }
        check(selectedInfo != null && selectedInfo.getCapabilitiesForType("video/avc")
                .isFormatSupported(clip.format), "Original codec info supports real extracted format");
        check(list.findEncoderForFormat(clip.format) == null, "Discovery does not invent an encoder");
        return selected;
    }

    private static void synchronous(Clip clip) throws Exception {
        MediaCodec codec = MediaCodec.createByCodecName(discover(clip));
        try {
            codec.configure(clip.format, null, null, 0);
            codec.start();
            decode(codec, clip, true);
            codec.flush();
            decode(codec, clip, false);
            codec.stop();
        } finally {
            codec.release();
        }
    }

    private static final class Events extends MediaCodec.Callback {
        final Clip clip;
        final Set<Long> times = new HashSet<>();
        int next, calls, formats;
        boolean inputEos, outputEos, retired;
        Throwable failure;
        Events(Clip clip) { this.clip = clip; }
        private void enter() {
            calls++;
            check(!retired, "Callback delivered after decoder retirement");
        }
        @Override public void onInputBufferAvailable(MediaCodec codec, int index) {
            try {
                enter();
                if (inputEos) return;
                if (next < clip.samples.size()) queue(codec, index, clip.samples.get(next++));
                else {
                    codec.queueInputBuffer(index, 0, 0, clip.endTime, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                    inputEos = true;
                }
            } catch (Throwable error) { failure = error; }
        }
        @Override public void onOutputBufferAvailable(MediaCodec codec, int index, MediaCodec.BufferInfo info) {
            try { enter(); outputEos |= output(codec, index, info, times); }
            catch (Throwable error) { failure = error; }
        }
        @Override public void onOutputFormatChanged(MediaCodec codec, MediaFormat format) {
            try { enter(); checkFormat(format); formats++; }
            catch (Throwable error) { failure = error; }
        }
        @Override public void onError(MediaCodec codec, MediaCodec.CodecException error) {
            calls++;
            failure = error;
        }
        void checkFailure() {
            if (failure != null) throw new AssertionError("Original MediaCodec callback failed", failure);
        }
    }

    private static void pump(Looper loop, BooleanSupplier complete, long milliseconds) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(milliseconds);
        do {
            HostLooper.drain(loop);
            if (complete.getAsBoolean()) return;
            Thread.sleep(2);
        } while (System.nanoTime() < deadline);
    }

    private static void asynchronous(Looper loop, Clip clip) throws Exception {
        MediaCodec codec = MediaCodec.createDecoderByType("video/avc");
        Events events = new Events(clip);
        boolean released = false;
        try {
            codec.setCallback(events, new Handler(loop));
            codec.configure(clip.format, null, null, 0);
            codec.start();
            pump(loop, () -> events.outputEos || events.failure != null, 10_000);
            events.checkFailure();
            check(events.outputEos && events.times.equals(clip.times) && events.formats > 0,
                    "Original callback path decodes all frames and EOS");

            codec.stop();
            events.retired = true;
            int stoppedCalls = events.calls;
            pump(loop, () -> events.failure != null, 100);
            events.checkFailure();
            check(events.calls == stoppedCalls, "Stop retires callback delivery");
            codec.release();
            released = true;
            pump(loop, () -> events.failure != null, 100);
            events.checkFailure();
            check(events.calls == stoppedCalls, "Release retires callback ownership");
        } finally {
            if (!released) codec.release();
        }
    }

    public static void main(String[] args) throws Exception {
        Path runtime = Path.of(args[0]).toRealPath();
        Path data = Files.createDirectories(Path.of(args[1]));
        Path movie = Path.of(args[2]).toRealPath();
        String mediaLibrary = args[3];
        try (MediaServicesFixture services = new MediaServicesFixture(runtime, data)) {
            Looper loop = services.loop;
            Clip clip = readClip(movie);
            if (Boolean.getBoolean("android.media.discoveryOnly")) discover(clip);
            else { synchronous(clip); asynchronous(loop, clip); }
            System.load(Path.of(args[4]).toAbsolutePath().toString());
            ndkProbe(movie.toString(), mediaLibrary);
            System.out.println(Boolean.getBoolean("android.media.discoveryOnly")
                    ? "PASS original MediaCodec discovery, named creation, capability matching and NDK decode"
                    : "PASS original MediaCodec sync decode, independent inputs, flush, async callbacks, retirement and NDK ownership");
        }
    }
}
