#include "webkit-client.cpp"
#include <atomic>
#include <cstdlib>

namespace {
std::weak_ptr<klj::web::Transport> transport;
std::atomic<int> released=0;
struct OwnerCallback final:klj::web::Callback {
 const std::thread::id owner=std::this_thread::get_id();
 ~OwnerCallback(){if(owner!=std::this_thread::get_id())std::abort();++released;}
 klj::web::Value invoke(klj::web::Event,const klj::web::Args&)override{return {};}
};
}
extern "C" __attribute__((visibility("default"))) void webkit_proof_open(const char*socket){
 auto value=std::make_shared<klj::web::Client>(socket,u"fixture-capability");
 transport=value->state;value->callbacks.emplace(1,std::make_shared<OwnerCallback>());
 klj::web::client=std::move(value);
}
extern "C" __attribute__((visibility("default"))) void webkit_proof_retire(int explicitClose){
 auto value=std::move(klj::web::client);if(explicitClose)value->retire();
}
extern "C" __attribute__((visibility("default"))) int webkit_proof_released(){return released.load()==1&&transport.expired();}
