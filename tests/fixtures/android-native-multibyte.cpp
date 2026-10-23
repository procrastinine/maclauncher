#include "exports.h"
#include <array>
#include <cassert>
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <iostream>
#include <string>
#include <vector>
static void *(*lookup)(const char *);
template<class T>static T function(const char *name){auto result=lookup(name);assert(result);return reinterpret_cast<T>(result);}
int main(int argc,char **argv){
  assert(argc==3);auto library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!library){std::cerr<<dlerror()<<'\n';return 1;}
  lookup=reinterpret_cast<void *(*)(const char *)>(dlsym(library,"klj_ctype_lookup"));assert(lookup);
  for(auto name:exports)assert(lookup(name));
  const auto bytes=std::strtoul(argv[2],nullptr,10);std::vector<unsigned char> storage(bytes+32,0xa7);auto state=storage.data()+16;
  auto reset=[&]{std::memset(state,0,bytes);};auto guards=[&]{for(unsigned i=0;i<16;i++)assert(storage[i]==0xa7&&storage[bytes+16+i]==0xa7);};
  auto initial=function<int(*)(const void *)>("mbsinit");
  auto decode=function<size_t(*)(wchar_t *,const char *,size_t,void *)>("mbrtowc");
  auto encode=function<size_t(*)(char *,wchar_t,void *)>("wcrtomb");
  constexpr char smile[]="\xf0\x9f\x99\x82";
  wchar_t character=0;reset();assert(initial(state));
  assert(decode(&character,smile,2,state)==size_t(-2)&&!initial(state));guards();
  assert(decode(&character,smile+2,2,state)==2&&character==0x1f642&&initial(state));guards();
  auto length=function<size_t(*)(const char *,size_t,void *)>("mbrlen");
  errno=0;assert(length("\xff",1,state)==size_t(-1)&&errno==EILSEQ&&initial(state));guards();
  assert(length("a",1,state)==1);guards();
  char encoded[8]{};assert(encode(encoded,character,state)==4&&!std::memcmp(encoded,smile,4));guards();
  auto decode16=function<size_t(*)(char16_t *,const char *,size_t,void *)>("mbrtoc16");
  char16_t c16=0;reset();assert(decode16(&c16,smile,4,state)==4&&c16==0xd83d);guards();
  assert(decode16(&c16,"",1,state)==size_t(-3)&&c16==0xde42&&initial(state));guards();
  auto encode16=function<size_t(*)(char *,char16_t,void *)>("c16rtomb");
  reset();assert(encode16(encoded,0xd83d,state)==0);assert(encode16(encoded,0xde42,state)==4&&!std::memcmp(encoded,smile,4));guards();
  std::string text=std::string("a")+smile;const char *source=text.c_str();wchar_t wide[4]{};
  auto decodeString=function<size_t(*)(wchar_t *,const char **,size_t,size_t,void *)>("mbsnrtowcs");
  reset();assert(decodeString(wide,&source,text.size()+1,4,state)==2&&!source&&wide[0]=='a'&&wide[1]==0x1f642);guards();
  const wchar_t *wideSource=wide;auto encodeString=function<size_t(*)(char *,const wchar_t **,size_t,size_t,void *)>("wcsnrtombs");
  std::memset(encoded,0,sizeof encoded);reset();assert(encodeString(encoded,&wideSource,3,sizeof encoded,state)==5&&!wideSource&&!std::strcmp(encoded,text.c_str()));guards();
  auto alias=function<size_t(*)(wchar_t *,const char **,size_t,void *,void *)>("mbsrtowcs_l");
  source=text.c_str();reset();assert(alias(wide,&source,4,state,nullptr)==2&&!source);guards();
  auto open=function<void*(*)(const char *,const char *)>("iconv_open");
  auto convert=function<size_t(*)(void *,char **,size_t *,char **,size_t *)>("iconv");auto close=function<int(*)(void *)>("iconv_close");
  auto descriptor=open("UTF-16LE","UTF-8");assert(descriptor&&descriptor!=reinterpret_cast<void *>(UINTPTR_MAX));
  char *input=text.data();size_t inputBytes=text.size();char converted[16]{};char *output=converted;size_t outputBytes=sizeof converted;
  assert(convert(descriptor,&input,&inputBytes,&output,&outputBytes)==0&&inputBytes==0&&outputBytes==10);assert(close(descriptor)==0);
  assert(converted[0]=='a'&&converted[1]==0&&uint8_t(converted[2])==0x3d&&uint8_t(converted[3])==0xd8&&uint8_t(converted[4])==0x42&&uint8_t(converted[5])==0xde);
  std::cout<<"PASS original Bionic multibyte states, guards, error mapping, aliases and iconv\n";
}
