#include "shared-presentation.h"
#include "target-time.h"
#include <cassert>
#include <cstring>
#include <unordered_set>
struct State { unsigned submitted=0; void *owner;uint64_t presented=0; };
static std::unordered_set<State*> live;
static unsigned creates,destroys,submits,releases,attempts;
static bool failCreate;
extern "C" void lifecycle_present(uint64_t frame){for(auto state:live)state->presented=frame;}
extern "C" void lifecycle_fail_create(){failCreate=true;}
extern "C" void *rsCreateFramePresenter(void *layer,void *owner,const RSPresenterOptions *o,RSPresenterError *error) {
 assert(layer&&owner&&o&&o->origin==RS_FRAME_BOTTOM_LEFT&&o->flags==RS_PRESENTER_FLIP_Y);
 ++attempts;if(failCreate){failCreate=false;std::strcpy(error->reason,"Owned fixture create rejection");return nullptr;}
 auto s=new State{0,owner};assert(live.insert(s).second);++creates;return s;
}
extern "C" int rsSubmitFramePresenter(void *v,const RSPresenterSubmission *s,RSFrameResult *r) {
 auto p=(State*)v;assert(live.contains(p)&&s->commandBuffer&&s->sourceTexture);++p->submitted;++submits;r->encoded=1;return RS_FRAME_OK;
}
extern "C" int rsSubmitFramePresenterAtTime(void *v,const RSPresenterSubmission *s,const RSPresentationTarget*,RSFrameResult*r){return rsSubmitFramePresenter(v,s,r);}
extern "C" int rsGetFramePresenterStatus(void *v,RSPresenterStatus*s) {
 auto p=(State*)v;assert(live.contains(p));s->encoded=p->submitted;s->presentedReal=p->presented?1:0;s->lastPresentedFrame=p->presented;return RS_FRAME_OK;
}
extern "C" int rsGetFramePresenterTiming(void *v,RSPresentationTiming*){assert(live.contains((State*)v));return RS_FRAME_OK;}
extern "C" void rsDestroyFramePresenter(void *v){auto p=(State*)v;assert(live.erase(p)==1);delete p;++destroys;}
extern "C" void rsReleaseFrameOwner(void *owner){assert(owner);++releases;}
extern "C" unsigned lifecycle_count(unsigned which){switch(which){case 0:return creates;case 1:return destroys;case 2:return live.size();case 3:return submits;case 4:return releases;default:return attempts;}}
