#pragma once
#include "diagnostics.hpp"
#include <OpenGL/gl3.h>
#include <array>
#include <cstddef>

namespace macfx {
// Timestamp queries coexist with a game's GL_TIME_ELAPSED query. Drivers without
// timestamp counters use elapsed queries only when the game has none active.
// Results are
// read only after the end timestamp is available; a full ring drops a sample
// rather than waiting for the GPU. Each instance belongs to one GL context.
class OpenGLGpuTimer {
    struct Sample {
        GLuint start=0,end=0;
        unsigned width=0,height=0;
        bool pending=false;
    };
    static constexpr size_t capacity=16;
    std::array<Sample,capacity> samples{};
    size_t active=capacity,cursor=0;
    bool initialized=false,failed=false;
    bool timestamps=true;
public:
    OpenGLGpuTimer()=default;
    OpenGLGpuTimer(const OpenGLGpuTimer &)=delete;
    OpenGLGpuTimer &operator=(const OpenGLGpuTimer &)=delete;
    void begin(unsigned width,unsigned height) noexcept {
        if(!gpuTimingEnabled() || failed || active!=capacity) return;
        if(!initialized) {
            GLint bits=0;glGetQueryiv(GL_TIMESTAMP,GL_QUERY_COUNTER_BITS,&bits);
            timestamps=bits>0;
            if(!timestamps) {
                glGetQueryiv(GL_TIME_ELAPSED,GL_QUERY_COUNTER_BITS,&bits);
                if(bits<=0) {failed=true;return;}
            }
            std::array<GLuint,capacity*2> names{};
            glGenQueries(GLsizei(timestamps?names.size():capacity),names.data());
            for(size_t i=0;i<capacity;++i) {
                samples[i].start=timestamps?names[i*2]:0;
                samples[i].end=names[timestamps?i*2+1:i];
                if((timestamps && !samples[i].start) || !samples[i].end) failed=true;
            }
            initialized=true;
            if(failed) {clear();failed=true;return;}
        }
        for(auto &sample:samples) if(sample.pending) {
            GLint ready=GL_FALSE;
            glGetQueryObjectiv(sample.end,GL_QUERY_RESULT_AVAILABLE,&ready);
            if(!ready) continue;
            GLuint64 start=0,end=0;
            if(timestamps) glGetQueryObjectui64v(sample.start,GL_QUERY_RESULT,&start);
            glGetQueryObjectui64v(sample.end,GL_QUERY_RESULT,&end);
            const bool valid=timestamps?(start>0 && end>=start):end>0;
            recordGpuDuration("opengl-copy-and-effects",sample.width,sample.height,
                valid?double(end-start)/1000000.0:0.0,valid);
            sample.pending=false;
        }
        if(!timestamps) {
            GLint current=0;glGetQueryiv(GL_TIME_ELAPSED,GL_CURRENT_QUERY,&current);
            if(current) return;
        }
        for(size_t offset=0;offset<capacity;++offset) {
            const size_t index=(cursor+offset)%capacity;
            auto &sample=samples[index];
            if(sample.pending) continue;
            active=index;cursor=(index+1)%capacity;
            sample.width=width;sample.height=height;
            if(timestamps) glQueryCounter(sample.start,GL_TIMESTAMP);
            else glBeginQuery(GL_TIME_ELAPSED,sample.end);
            return;
        }
    }
    void end() noexcept {
        if(active==capacity) return;
        auto &sample=samples[active];
        if(timestamps) glQueryCounter(sample.end,GL_TIMESTAMP);
        else glEndQuery(GL_TIME_ELAPSED);
        sample.pending=true;active=capacity;
    }
    // Call while this instance's context is current, before context destruction.
    // The destructor intentionally does not issue GL calls on an unknown thread.
    void clear() noexcept {
        end();
        if(initialized) for(auto &sample:samples) {
            if(sample.start) glDeleteQueries(1,&sample.start);
            if(sample.end) glDeleteQueries(1,&sample.end);
            sample={};
        }
        active=capacity;cursor=0;initialized=false;failed=false;
    }
};
}
