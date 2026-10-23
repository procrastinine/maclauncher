#include "memory-info.h"
#include <assert.h>
#include <limits.h>

int main(void) {
    int64_t values[4];
    klj_memory_info_values(10000,1999,80,values);
    assert(values[0]==1999&&values[1]==10000&&values[2]==2000&&values[3]==1);
    klj_memory_info_values(10000,2000,80,values);
    assert(values[2]==2000&&values[3]==0);
    klj_memory_info_values(10000,0,0,values);
    assert(values[2]==0&&values[3]==0);
    klj_memory_info_values(10000,0,101,values);
    assert(values[2]==0&&values[3]==0);
    klj_memory_info_values(INT64_MAX,INT64_MAX,1,values);
    assert(values[1]==INT64_MAX&&values[2]==(INT64_MAX/100)*99&&values[3]==0);
}
