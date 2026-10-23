typedef unsigned int u32;
typedef unsigned long long u64;
u64 wide(u32 a,u64 b,u32 c){return b+a+c;}
u32 callback(u32 (*function)(u32),u32 argument){return function(argument)+2;}
