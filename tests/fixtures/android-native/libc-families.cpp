#include <cassert>
#include <cstring>
#include <cstdlib>
#include <string>
#include <sys/wait.h>
#include <unistd.h>
extern "C" void *klj_ctype_lookup(const char *);
extern "C" void *klj_exec_lookup(const char *);
extern "C" const char *kl_guest_path(const char *file,char *,size_t){return file;}
extern "C" void *kl_shim_lookup(const char *name){return !std::strcmp(name,"access")?reinterpret_cast<void *>(access):nullptr;}

int main(int argc,char **argv){
 if(argc>1){assert(argc==3&&!std::strcmp(argv[1],"--exec-child")&&!std::strcmp(argv[2],"argument"));assert(!std::strcmp(getenv("MACLAUNCHER_EXEC_FIXTURE"),"expected"));return 42;}
 auto classify=[](const char *name,int value){using Call=int(*)(int);auto fn=reinterpret_cast<Call>(klj_ctype_lookup(name));assert(fn);return fn(value);};
 assert(classify("isalpha",'A')&&classify("isalpha",'z')&&!classify("isalpha",0xe9)&&!classify("isalpha",-1));
 assert(classify("isblank",'\t')&&!classify("isblank",'\n')&&classify("toupper",'q')=='Q'&&classify("tolower",'Q')=='q');
 assert(!klj_ctype_lookup("not_a_character_api"));
 std::string executable=argv[0],directory=executable.substr(0,executable.find_last_of('/')),basename=executable.substr(executable.find_last_of('/')+1);
 setenv("PATH",directory.c_str(),1);setenv("MACLAUNCHER_EXEC_FIXTURE","expected",1);
 for(const char *name:{"execvp","execl","execle"}){
  pid_t child=fork();assert(child>=0);
  if(!child){
   if(!std::strcmp(name,"execvp")){using Call=int(*)(const char*,char*const*);char *arguments[]={const_cast<char *>(basename.c_str()),const_cast<char *>("--exec-child"),const_cast<char *>("argument"),nullptr};reinterpret_cast<Call>(klj_exec_lookup(name))(basename.c_str(),arguments);}
   else if(!std::strcmp(name,"execl")){
    // Fixed native arguments place pointer words in the same GP registers as
    // the Android variadic caller. The actual AAPCS64 thunk builds its va_list.
    using Call=int(*)(const char*,const char*,const char*,const char*,const char*);
    reinterpret_cast<Call>(klj_exec_lookup(name))(executable.c_str(),"probe","--exec-child","argument",nullptr);
   }else{
    char *environment[]={const_cast<char *>("MACLAUNCHER_EXEC_FIXTURE=expected"),nullptr};
    using Call=int(*)(const char*,const char*,const char*,const char*,const char*,char**);
    reinterpret_cast<Call>(klj_exec_lookup(name))(executable.c_str(),"probe","--exec-child","argument",nullptr,environment);
   }
   _exit(127);
  }
  int status=0;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==42);
 }
 return 0;
}
