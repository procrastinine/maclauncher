package main

/*
#include <stdint.h>
static uint64_t bridge_add(uint64_t left,uint64_t right){return left+right;}
*/
import "C"
import (
 "runtime"
 "sync"
 "time"
)

//export ProbeGoRuntime
func ProbeGoRuntime(rounds C.int) C.uint64_t {
 if rounds<1 || rounds>16 { panic("invalid probe rounds") }
 if C.bridge_add(40,2)!=42 { panic("cgo return path") }
 println("GO STAGE cgo callback returned")
 old:=runtime.GOMAXPROCS(4);defer runtime.GOMAXPROCS(old)
 const workers=8
 var group sync.WaitGroup
 var retained [workers][]byte
 for worker:=0;worker<workers;worker++ {
  group.Add(1)
  go func(index int){
   defer group.Done()
   if index==0 {runtime.LockOSThread();defer runtime.UnlockOSThread()}
   for round:=0;round<int(rounds);round++ {
    data:=make([]byte,128<<10)
    for offset:=0;offset<len(data);offset++ {data[offset]=byte(index+round+offset)}
    runtime.Gosched()
    if data[0]!=byte(index+round)||data[len(data)-1]!=byte(index+round+len(data)-1){panic("goroutine allocator contents")}
    retained[index]=data
   }
  }(worker)
 }
 group.Wait();println("GO STAGE worker allocation completed");runtime.GC();println("GO STAGE collection completed")
 for index,data:=range retained {if data[4096]!=byte(index+int(rounds)-1+4096){panic("retained GC contents")}}
 <-time.After(time.Millisecond)
 println("GO STAGE timer returned")
 return C.uint64_t(0x12340000|uint64(rounds))
}
func main(){}
