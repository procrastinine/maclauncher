/* MacLauncher build qualification; no game data is distributed with this tool. */
#include <stdio.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/pixdesc.h>

int main(int argc, char **argv) {
    const AVCodecDescriptor *descriptor = avcodec_descriptor_get(AV_CODEC_ID_BINKVIDEO2);
    const AVCodec *decoder = avcodec_find_decoder(AV_CODEC_ID_BINKVIDEO2);
    if (avcodec_version() != LIBAVCODEC_VERSION_INT ||
        avformat_version() != LIBAVFORMAT_VERSION_INT ||
        !descriptor || strcmp(descriptor->name, "binkvideo2") ||
        !decoder || strcmp(decoder->name, "binkvideo2")) {
        fprintf(stderr, "The compiled FFmpeg headers, codec descriptors and decoder do not agree.\n");
        return 1;
    }
    if (argc == 1) {
        printf("{\"bink2Descriptor\":true,\"bink2Decoder\":true,\"headerLibraryVersionsMatch\":true,\"avcodecVersion\":%u,\"avformatVersion\":%u}\n",
               avcodec_version(), avformat_version());
        return 0;
    }
    if (argc != 2) return 2;
    AVFormatContext *format = NULL;
    AVCodecContext *codec = NULL;
    AVPacket *packet = NULL;
    AVFrame *frame = NULL;
    int status = 1, frames = 0, stream_index = -1;
    unsigned long long checksum = 1469598103934665603ULL;
    if (avformat_open_input(&format, argv[1], NULL, NULL) < 0 ||
        avformat_find_stream_info(format, NULL) < 0) goto finish;
    stream_index = av_find_best_stream(format, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    if (stream_index < 0 || format->streams[stream_index]->codecpar->codec_id != AV_CODEC_ID_BINKVIDEO2) goto finish;
    codec = avcodec_alloc_context3(decoder);
    if (!codec || avcodec_parameters_to_context(codec, format->streams[stream_index]->codecpar) < 0) goto finish;
    codec->thread_count = 2;
    if (avcodec_open2(codec, decoder, NULL) < 0) goto finish;
    packet = av_packet_alloc(); frame = av_frame_alloc();
    if (!packet || !frame) goto finish;
    for (int packets = 0; packets < 120 && frames < 12; packets++) {
        if (av_read_frame(format, packet) < 0) break;
        if (packet->stream_index == stream_index) {
            if (avcodec_send_packet(codec, packet) < 0) goto finish;
            int result;
            while ((result = avcodec_receive_frame(codec, frame)) >= 0) {
                const AVPixFmtDescriptor *pixels = av_pix_fmt_desc_get(frame->format);
                if (!pixels || frame->width < 1 || frame->height < 1 || !frame->data[0]) goto finish;
                for (int y = 0; y < frame->height; y++) for (int x = 0; x < frame->width; x++) {
                    checksum ^= frame->data[0][y * frame->linesize[0] + x];
                    checksum *= 1099511628211ULL;
                }
                frames++;
                av_frame_unref(frame);
                if (frames == 12) break;
            }
            if (result < 0 && result != AVERROR(EAGAIN) && result != AVERROR_EOF) goto finish;
        }
        av_packet_unref(packet);
    }
    if (frames == 12) {
        printf("{\"decodedFrames\":%d,\"lumaChecksum\":\"%016llx\",\"bink2Decoder\":true}\n", frames, checksum);
        status = 0;
    }
finish:
    if (status) fprintf(stderr, "The bounded Bink 2 movie decode failed after %d frames.\n", frames);
    av_packet_free(&packet); av_frame_free(&frame);
    avcodec_free_context(&codec); avformat_close_input(&format);
    return status;
}
