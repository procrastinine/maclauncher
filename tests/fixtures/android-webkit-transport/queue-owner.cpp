#include "webkit-socket.h"
#include <sys/un.h>
#include <cstdio>

using namespace klj::web;
static Value text(const char*value){std::u16string result;while(*value)result.push_back(*value++);return Value(std::move(result));}
static int connectTo(const char*path,const char*token="fixture-capability"){
 int fd=socket(AF_UNIX,SOCK_STREAM,0);sockaddr_un address{};address.sun_family=AF_UNIX;strcpy(address.sun_path,path);
 if(fd<0||connect(fd,reinterpret_cast<sockaddr*>(&address),sizeof(address)))throw std::runtime_error("fixture connection failed");
 sendFrame(fd,Message::hello,0,0,0,text(token));return fd;
}
static void initialize(int fd,const char*root="/data/user/0/probe"){
 std::string directory=std::string(root)+"/files/webview";
 sendFrame(fd,Message::request,uint32_t(Op::initialize),1,0,Value(Args{text(directory.c_str()),text(root),Value(false)}));
}
int main(int argc,char**argv){
 if(argc!=2)return 2;int first=-1,second=-1;Frame callback;bool hasCallback=false;
 try{
  first=connectTo(argv[1]);Frames frames;initialize(first);auto initialized=frames.wait(first);
  if(Message(initialized.header.kind)!=Message::reply)throw std::runtime_error("fixture initialization failed");
  sendFrame(first,Message::request,uint32_t(Op::cookieCommand),2,3,Value(Args{text("set"),text("{\"url\":\"https://fixture.invalid/\",\"value\":\"queue=owned; Path=/\"}")}));
  bool accepted=false;
  while(!accepted||!hasCallback){auto frame=frames.wait(first);if(Message(frame.header.kind)==Message::reply)accepted=true;else if(Message(frame.header.kind)==Message::event&&frame.header.operation==uint32_t(Event::result)){callback=std::move(frame);hasCallback=true;}else throw std::runtime_error("unexpected fixture cookie response");}
  // Receiving the completion does not run its Java callback. A slow Android
  // owner must not stop the physical owner from serving a different process.
  second=connectTo(argv[1],"second-capability");initialize(second,"/data/user/0/other");pollfd item{second,POLLIN,0};
  if(poll(&item,1,2000)!=1)throw std::runtime_error("void completion blocked another application's initialization");
  Frames other;auto reply=other.wait(second);if(Message(reply.header.kind)!=Message::reply)throw std::runtime_error("second initialization failed: "+errorString(reply.value));
  if(callback.header.id)sendFrame(first,Message::eventReply,0,callback.header.id,0,Value());
  close(second);close(first);puts("PASS asynchronous callback preserves the shared physical queue");return 0;
 }catch(const std::exception&error){
  if(first>=0&&hasCallback&&callback.header.id)try{sendFrame(first,Message::eventReply,0,callback.header.id,0,Value());}catch(...){}
  if(second>=0)close(second);if(first>=0)close(first);fprintf(stderr,"%s\n",error.what());return 1;
 }
}
