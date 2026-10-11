/* MacLauncher movie bridge. FFmpeg remains a separate, versioned native process.
 * Binary protocol MLMV1: header, then bounded video/audio packets with timestamps.
 */
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/imgutils.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define MAX_FRAME_BYTES (64u * 1024u * 1024u)
#define MAX_AUDIO_BYTES (256u * 1024u)
static void u32(uint32_t value) { unsigned char data[4]; for (int i=0;i<4;i++) data[i]=(value>>(i*8))&255; if (fwrite(data,1,4,stdout)!=4) exit(3); }
static void u64(uint64_t value) { u32((uint32_t)value); u32((uint32_t)(value>>32)); }
static int64_t nanos(int64_t value, AVRational base) { return value == AV_NOPTS_VALUE ? 0 : av_rescale_q(value,base,(AVRational){1,1000000000}); }
static void packet(uint32_t type, uint32_t size, int64_t pts, int64_t end, uint32_t width, uint32_t height, const void *bytes) {
    int64_t start=pts<0?0:pts, finish=end<start?start:end;
    u32(type); u32(size); u64(start); u64(finish); u32(width); u32(height);
    if (size && fwrite(bytes,1,size,stdout)!=size) exit(3);
}
typedef struct { AVCodecContext *codec; AVStream *stream; struct SwsContext *scale; SwrContext *resample; int video; int64_t clock; } Decoder;
static int output_frame(Decoder *decoder, AVFrame *frame) {
    int64_t pts=nanos(frame->best_effort_timestamp,decoder->stream->time_base);
    if (frame->best_effort_timestamp==AV_NOPTS_VALUE) pts=decoder->clock;
    if (decoder->video) {
        if (frame->width<=0 || frame->height<=0 || frame->width>8192 || frame->height>8192 || (uint64_t)frame->width*frame->height*4>MAX_FRAME_BYTES) return -1;
        uint32_t size=(uint32_t)frame->width*frame->height*4;
        uint8_t *bytes=av_malloc(size); if (!bytes) return -1;
        uint8_t *dest[4]={bytes,0,0,0}; int stride[4]={frame->width*4,0,0,0};
        decoder->scale=sws_getCachedContext(decoder->scale,frame->width,frame->height,frame->format,frame->width,frame->height,AV_PIX_FMT_BGRA,SWS_BILINEAR,0,0,0);
        if (!decoder->scale || sws_scale(decoder->scale,(const uint8_t * const*)frame->data,frame->linesize,0,frame->height,dest,stride)!=frame->height) { av_free(bytes); return -1; }
        int64_t duration=nanos(frame->duration,decoder->stream->time_base);
        if (duration<=0) { AVRational rate=decoder->stream->avg_frame_rate; duration=(rate.num>0 && rate.den>0)?av_rescale_q(1,av_inv_q(rate),(AVRational){1,1000000000}):33333333; }
        decoder->clock=pts+duration; packet(1,size,pts,decoder->clock,frame->width,frame->height,bytes); av_free(bytes);
    } else {
        if (frame->sample_rate<=0 || frame->nb_samples<=0 || frame->nb_samples>65536) return -1;
        if (!decoder->resample) {
            AVChannelLayout layout=AV_CHANNEL_LAYOUT_STEREO;
            if (swr_alloc_set_opts2(&decoder->resample,&layout,AV_SAMPLE_FMT_FLT,48000,&frame->ch_layout,frame->format,frame->sample_rate,0,0)<0 || swr_init(decoder->resample)<0) return -1;
        }
        int capacity=swr_get_out_samples(decoder->resample,frame->nb_samples);
        if (capacity<=0 || (uint64_t)capacity*8>MAX_AUDIO_BYTES) return -1;
        uint8_t *bytes=av_malloc((size_t)capacity*8); if (!bytes) return -1;
        uint8_t *dest[1]={bytes};
        int samples=swr_convert(decoder->resample,dest,capacity,(const uint8_t**)frame->extended_data,frame->nb_samples);
        if (samples<0) { av_free(bytes); return -1; }
        decoder->clock=pts+av_rescale(samples,1000000000,48000);
        packet(2,(uint32_t)samples*8,pts,decoder->clock,0,0,bytes); av_free(bytes);
    }
    return 0;
}
static int drain(Decoder *decoder, AVFrame *frame) {
    int code;
    while ((code=avcodec_receive_frame(decoder->codec,frame))>=0) {
        if (output_frame(decoder,frame)<0) { av_frame_unref(frame); return -1; }
        av_frame_unref(frame);
    }
    return code==AVERROR(EAGAIN) || code==AVERROR_EOF ? 0 : code;
}
static int open_decoder(AVFormatContext *format, enum AVMediaType type, Decoder *decoder) {
    const AVCodec *codec=NULL; int index=av_find_best_stream(format,type,-1,-1,&codec,0);
    if (index<0) return index;
    decoder->codec=avcodec_alloc_context3(codec); if (!decoder->codec) return AVERROR(ENOMEM);
    decoder->stream=format->streams[index]; decoder->video=type==AVMEDIA_TYPE_VIDEO;
    if (avcodec_parameters_to_context(decoder->codec,decoder->stream->codecpar)<0) return -1;
    decoder->codec->thread_count=2;
    if (avcodec_open2(decoder->codec,codec,NULL)<0) return -1;
    return index;
}
int main(int argc, char **argv) {
    if (argc==2 && !strcmp(argv[1],"--version")) { printf("maclauncher-minori-movie-v1 / FFmpeg %s\n",av_version_info()); return 0; }
    if (argc!=2 || argv[1][0]!='/') { fprintf(stderr,"Choose an absolute original movie path.\n"); return 2; }
    AVFormatContext *format=NULL; AVPacket *input=NULL; AVFrame *frame=NULL;
    Decoder video={0},audio={0}; int status=2;
    av_log_set_level(AV_LOG_ERROR);
    AVDictionary *options=NULL;
    av_dict_set(&options,"protocol_whitelist","file,pipe",0);
    if (avformat_open_input(&format,argv[1],NULL,&options)<0) goto done;
    av_dict_free(&options);
    if (avformat_find_stream_info(format,NULL)<0) goto done;
    int video_index=open_decoder(format,AVMEDIA_TYPE_VIDEO,&video);
    if (video_index<0 || video.codec->width<=0 || video.codec->height<=0 || video.codec->width>8192 || video.codec->height>8192) goto done;
    int audio_index=open_decoder(format,AVMEDIA_TYPE_AUDIO,&audio);
    if (fwrite("MLMV1\0\0\0",1,8,stdout)!=8) goto done;
    u32(video.codec->width); u32(video.codec->height); u32(audio_index>=0?48000:0); u32(0);
    input=av_packet_alloc(); frame=av_frame_alloc(); if (!input || !frame) goto done;
    int read;
    while ((read=av_read_frame(format,input))>=0) {
        Decoder *decoder=input->stream_index==video_index?&video:(input->stream_index==audio_index?&audio:NULL);
        if (decoder) {
            int code=avcodec_send_packet(decoder->codec,input);
            if (code==AVERROR(EAGAIN)) { if (drain(decoder,frame)<0) goto done; code=avcodec_send_packet(decoder->codec,input); }
            if (code<0 || drain(decoder,frame)<0) goto done;
        }
        av_packet_unref(input);
    }
    if (read!=AVERROR_EOF) goto done;
    if (avcodec_send_packet(video.codec,NULL)<0 || drain(&video,frame)<0) goto done;
    if (audio_index>=0 && (avcodec_send_packet(audio.codec,NULL)<0 || drain(&audio,frame)<0)) goto done;
    packet(3,0,0,video.clock>audio.clock?video.clock:audio.clock,0,0,NULL);
    status=0;
done:
    if (status) fprintf(stderr,"Minori movie decode failed.\n");
    av_dict_free(&options); sws_freeContext(video.scale); swr_free(&audio.resample);
    avcodec_free_context(&video.codec); avcodec_free_context(&audio.codec);
    av_packet_free(&input); av_frame_free(&frame); avformat_close_input(&format);
    return status;
}
