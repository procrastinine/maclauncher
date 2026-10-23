#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "native-clock/interval-timer.h"
int main(void) {
    for(int which=0;which<3;which++) {
        struct klj_timer_value previous,actual,requested={{3,654321},{30,123456}};
        assert(!klj_getitimer(which,&previous));
        memset(&actual,0xa5,sizeof actual);
        assert(!klj_setitimer(which,&requested,&actual));
        assert(!memcmp(&actual,&previous,sizeof actual));
        memset(&actual,0xa5,sizeof actual);
        assert(!klj_getitimer(which,&actual));
        assert(actual.interval.seconds==3&&actual.interval.microseconds==654321);
        assert(actual.value.seconds>=29&&actual.value.seconds<=30);
        assert(actual.value.microseconds>=0&&actual.value.microseconds<1000000);
        requested.interval.microseconds=(INT64_C(1)<<32)+17;
        errno=0;assert(klj_setitimer(which,&requested,NULL)==-1&&errno==EINVAL);
        requested.interval.microseconds=-1;
        errno=0;assert(klj_setitimer(which,&requested,NULL)==-1&&errno==EINVAL);
        assert(!klj_setitimer(which,NULL,&actual));
        memset(&actual,0xa5,sizeof actual);
        assert(!klj_getitimer(which,&actual));
        assert(!actual.value.seconds&&!actual.value.microseconds);
        assert(!klj_setitimer(which,&previous,NULL));
    }
    errno=0;assert(klj_getitimer(0,NULL)==-1&&errno==EFAULT);
    struct klj_timer_value value;
    errno=0;assert(klj_getitimer(3,&value)==-1&&errno==EINVAL);
    puts("PASS Linux interval timer layout, kernel ownership, full-width validation and disarming");
}
