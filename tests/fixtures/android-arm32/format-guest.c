#include <stdarg.h>
#include <stdio.h>
#include <string.h>
static int format_list(char *buffer,size_t size,const char *format,...){
    va_list list;va_start(list,format);int result=vsnprintf(buffer,size,format,list);va_end(list);return result;
}
int exercise_formats(void){
    char buffer[256];
    int result=sprintf(buffer,"%s:%d:%u:%ld:%lld:%.2f","guest",-17,4000000000u,-2000000000L,0x123456789LL,1.25);
    if(result!=48||strcmp(buffer,"guest:-17:4000000000:-2000000000:4886718345:1.25"))return 1;
    result=format_list(buffer,sizeof buffer,"%d/%s/%lld/%*.*f/%u",7,"list",-1234567890123LL,8,3,2.5,99u);
    if(result<0||strcmp(buffer,"7/list/-1234567890123/   2.500/99"))return 2;
    result=snprintf(buffer,8,"%s:%d","abcdef",12345);
    if(result!=12||strcmp(buffer,"abcdef:"))return 3;
    result=snprintf(buffer,sizeof buffer,"%p",(void*)0x12345678);
    if(result!=10||strcmp(buffer,"0x12345678"))return 4;
    return 0;
}
