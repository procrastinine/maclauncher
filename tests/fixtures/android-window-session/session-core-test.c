#include "session-core.h"
#include "window-placement.h"
#include "resolution.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static unsigned long checks;
#define CHECK(x) do{checks++;assert(x);}while(0)
typedef struct {int fail,step,live,wrongSize,scale,busy,binds,claims,requestWidth,requestHeight,fit,pointsWidth,pointsHeight;char log[128];int n;} Backend;
static void logit(Backend*b,char c){CHECK(b->n<127);b->log[b->n++]=c;b->log[b->n]=0;}
static int acquire(Backend*b,char c){logit(b,c);return ++b->step!=b->fail;}
static int video(void*p){Backend*b=p;if(!acquire(b,'V'))return 0;b->live|=1;return 1;}
static int window(void*p,int w,int h){Backend*b=p;CHECK(w==(b->requestWidth?b->requestWidth:640)&&h==(b->requestHeight?b->requestHeight:384));if(!acquire(b,'W'))return 0;b->live|=2;if(b->fit){KLWindowPlacement placement=kl_window_placement(w,h,0,0,1000,700,50,0,0,0);b->pointsWidth=placement.width;b->pointsHeight=placement.height;}return 1;}
static int layer(void*p){Backend*b=p;if(!acquire(b,'L'))return 0;b->live|=4;return 1;}
static int drawable(void*p,int w,int h,int*outW,int*outH){Backend*b=p;if(!acquire(b,'D'))return 0;int scale=b->scale?b->scale:1;if(b->fit){w=b->pointsWidth;h=b->pointsHeight;}*outW=b->wrongSize?0:w*scale;*outH=h*scale;return 1;}
static int bind(void*p,int w,int h){Backend*b=p;CHECK(w>0&&h>0);b->binds++;b->live|=8;return acquire(b,'B');}
static int claim(void*p,KLSessionBranch branch){Backend*b=p;CHECK(branch>=KL_SESSION_GLES&&branch<=KL_SESSION_NATIVE);b->claims++;return acquire(b,'C');}
static int stop(void*p){Backend*b=p;logit(b,'S');return b->busy?-1:1;}
static int unbind(void*p){Backend*b=p;logit(b,'b');b->live&=~8;return 1;}
static void destroyLayer(void*p){Backend*b=p;logit(b,'l');b->live&=~4;}
static void destroyWindow(void*p){Backend*b=p;logit(b,'w');b->live&=~2;}
static void quit(void*p){Backend*b=p;logit(b,'v');b->live&=~1;}
static KLSessionOps ops={video,window,layer,drawable,bind,claim,stop,unbind,destroyLayer,destroyWindow,quit};
int main(void){
 for(int pass=0;pass<1000;pass++)for(int failure=0;failure<=6;failure++){
  Backend b={.fail=failure};KLSession s;CHECK(kl_session_init(&s,&ops,&b,1));CHECK(!kl_session_open(&s,2,640,384));CHECK(b.step==0);
  int opened=kl_session_open(&s,1,640,384);CHECK(opened==(failure==0||failure==6));CHECK(!kl_session_open(&s,1,640,384));
  if(opened){int adopted=kl_session_claim(&s,1,(KLSessionBranch)(pass%2+1),640,384);CHECK(adopted==(failure!=6));if(adopted){
   CHECK(kl_session_close(&s,1)==KL_SESSION_BUSY);CHECK(!kl_session_release(&s,1,s.branch,0));CHECK(!kl_session_claim(&s,1,s.branch,640,384));
   b.busy=1;CHECK(kl_session_release(&s,1,s.branch,1)==KL_SESSION_BUSY);CHECK(s.state==KL_SESSION_CLAIMED&&b.live==15);
   b.busy=0;CHECK(kl_session_release(&s,1,s.branch,1)==1);CHECK(!kl_session_claim(&s,1,KL_SESSION_GLES,640,384));
  }}
  CHECK(kl_session_close(&s,2)==0);CHECK(kl_session_close(&s,1)==1);CHECK(b.live==0&&s.acquired==0&&s.state==KL_SESSION_CLOSED);int n=b.n;CHECK(kl_session_close(&s,1)==1&&b.n==n);
  if(failure==5)CHECK(strstr(b.log,"BSblwv")!=NULL); /* publication failed after acquire */
 }
 Backend b={.wrongSize=1};KLSession s;CHECK(kl_session_init(&s,&ops,&b,1));CHECK(!kl_session_open(&s,1,640,384));CHECK(b.binds==0);CHECK(kl_session_close(&s,1));CHECK(b.live==0);
 b=(Backend){0};CHECK(kl_session_init(&s,&ops,&b,1));CHECK(kl_session_open(&s,1,640,384));CHECK(!kl_session_claim(&s,1,KL_SESSION_GLES,1280,768));CHECK(kl_session_claim(&s,1,KL_SESSION_GLES,640,384));
 CHECK(kl_session_commit(&s,1,KL_SESSION_GLES,640,384));CHECK(b.binds==1);b.fail=b.step+1;CHECK(!kl_session_commit(&s,1,KL_SESSION_GLES,800,612));CHECK(s.width==640&&s.height==384);b.fail=0;CHECK(kl_session_commit(&s,1,KL_SESSION_GLES,800,612));CHECK(s.width==800&&s.height==612);
 CHECK(!kl_session_commit(&s,2,KL_SESSION_GLES,10,20));CHECK(!kl_session_commit(&s,1,KL_SESSION_NATIVE,10,20));CHECK(kl_session_release(&s,1,KL_SESSION_GLES,1));CHECK(kl_session_close(&s,1));CHECK(!b.live);
 b=(Backend){0};CHECK(kl_session_init(&s,&ops,&b,1));CHECK(kl_session_open(&s,1,640,384));CHECK(!kl_session_resize_ready(&s,2,384,640));CHECK(kl_session_resize_ready(&s,1,384,640));CHECK(s.width==384&&s.height==640&&b.binds==2);CHECK(kl_session_claim(&s,1,KL_SESSION_NATIVE,384,640));CHECK(!kl_session_resize_ready(&s,1,640,384));CHECK(kl_session_release(&s,1,KL_SESSION_NATIVE,1));CHECK(kl_session_close(&s,1)&&!b.live);
 b=(Backend){0};CHECK(kl_session_init(&s,&ops,&b,1));CHECK(kl_session_open(&s,1,640,384));b.wrongSize=1;CHECK(!kl_session_resize_ready(&s,1,384,640));CHECK(s.width==640&&s.height==384&&b.binds==1&&s.state==KL_SESSION_FAILED);CHECK(kl_session_close(&s,1)&&!b.live);
 /* Logical point requests accept the real Retina backing extent. Claims and
    publication still use pixels, including orientation before a producer starts. */
 b=(Backend){.scale=2};CHECK(kl_session_init(&s,&ops,&b,1));CHECK(kl_session_open(&s,1,640,384));CHECK(s.width==1280&&s.height==768);CHECK(!kl_session_claim(&s,1,KL_SESSION_GLES,640,384));CHECK(kl_session_resize_ready(&s,1,384,640));CHECK(s.width==768&&s.height==1280);CHECK(kl_session_claim(&s,1,KL_SESSION_GLES,768,1280));CHECK(kl_session_release(&s,1,KL_SESSION_GLES,1));CHECK(kl_session_close(&s,1)&&!b.live);
 /* Presentation adopts committed backing pixels, including a fitted tablet
    window and source-allocation ratio. Logical requests cannot claim output. */
 const struct {int fit,numerator,denominator,outputW,outputH,sourceW,sourceH;} tablet[]={
  {0,1,1,2560,1600,2560,1600},{1,1,1,2000,1250,2000,1250},{1,3,2,2000,1250,1334,834}
 };
 for(unsigned i=0;i<sizeof(tablet)/sizeof(tablet[0]);i++){
  b=(Backend){.requestWidth=1280,.requestHeight=800,.scale=2,.fit=tablet[i].fit};
  CHECK(kl_session_init(&s,&ops,&b,1));CHECK(kl_session_open(&s,1,1280,800));
  CHECK(s.width==tablet[i].outputW&&s.height==tablet[i].outputH);
  CHECK(!kl_session_claim(&s,1,KL_SESSION_NATIVE,1280,800));
  CHECK(klj_resolution_dimension(s.width,tablet[i].numerator,tablet[i].denominator)==tablet[i].sourceW);
  CHECK(klj_resolution_dimension(s.height,tablet[i].numerator,tablet[i].denominator)==tablet[i].sourceH);
  CHECK(kl_session_claim(&s,1,KL_SESSION_NATIVE,s.width,s.height));
  CHECK(kl_session_release(&s,1,KL_SESSION_NATIVE,1));CHECK(kl_session_close(&s,1)&&!b.live);
 }
 printf("PASS %lu lifecycle/partial-failure/owner/three-branch/drain/committed-extent checks; mock backend, no window or GPU\n",checks);
}
