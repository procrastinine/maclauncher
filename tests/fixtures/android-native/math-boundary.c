#include <assert.h>
#include <complex.h>
#include <dlfcn.h>
#include <fenv.h>
#include <math.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static void *(*lookup)(const char *);
typedef struct { uint32_t control,status; } AndroidEnvironment;
#define CALL(name,type) ((type)lookup(name))
static void *round_worker(void *argument) {
  int mode=(int)(intptr_t)argument;
  AndroidEnvironment saved;
  assert(CALL("fegetenv",int(*)(AndroidEnvironment*))(&saved)==0);
  assert(CALL("fesetround",int(*)(int))(mode)==0);
  for(int i=0;i<10000;i++)assert(CALL("fegetround",int(*)(void))()==mode);
  assert(CALL("fesetenv",int(*)(const AndroidEnvironment*))(&saved)==0);
  return NULL;
}
int main(int argc,char **argv){
  assert(argc==2);
  void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
  if(!library){fprintf(stderr,"%s\n",dlerror());return 1;}
  lookup=dlsym(library,"klj_math_lookup");assert(lookup);
  #include "math-expected.inc"
  assert(!lookup("not_a_libm_symbol"));
  assert(CALL("floor",double(*)(double))(-1.5)==-2);
  assert(CALL("floorf",float(*)(float))(-1.5f)==-2);
  assert(CALL("__signbit",int(*)(double))(-0.0));
  assert(!CALL("__signbitf",int(*)(float))(0.0f));
  assert(CALL("fmin",double(*)(double,double))(NAN,3)==3);
  assert(CALL("fmaxf",float(*)(float,float))(3,NAN)==3);
  assert(CALL("lround",long(*)(double))(-2.5)==-3);
  assert(CALL("llroundf",long long(*)(float))(2.5f)==3);
  assert(CALL("finite",int(*)(double))(1)&&!CALL("finitef",int(*)(float))(INFINITY));
  assert(CALL("drem",double(*)(double,double))(5,2)==1);
  assert(CALL("dremf",float(*)(float,float))(7,2)==-1);
  assert(CALL("significand",double(*)(double))(12)==1.5);
  assert(CALL("significandf",float(*)(float))(12)==1.5f);
  assert(CALL("scalbf",float(*)(float,float))(1.5f,3)==12);
  assert(isnan(CALL("scalbf",float(*)(float,float))(1,1.5f)));
  int sign=0;double gamma=CALL("gamma_r",double(*)(double,int*))(-0.5,&sign);
  assert(sign==-1&&fabs(gamma-log(2*sqrt(acos(-1))))<1e-12);
  assert(fabsf(CALL("gammaf_r",float(*)(float,int*))(-0.5f,&sign)-(float)gamma)<1e-6f&&sign==-1);
  assert(CALL("cabs",double(*)(double complex))(3+4*I)==5);
  assert(CALL("cabsf",float(*)(float complex))(3.0f+4.0f*I)==5);
  double complex z=CALL("csqrt",double complex(*)(double complex))(-1);
  assert(creal(z)==0&&cimag(z)==1);
  double sine,cosine;CALL("sincos",void(*)(double,double*,double*))(0.75,&sine,&cosine);
  assert(fabs(sine-sin(.75))<1e-15&&fabs(cosine-cos(.75))<1e-15);
  for(float x=.125f;x<30;x+=.125f){
    assert(fabsf(CALL("j0f",float(*)(float))(x)-(float)j0(x))<2e-6f);
    assert(fabsf(CALL("y0f",float(*)(float))(x)-(float)y0(x))<2e-6f);
    assert(fabsf(CALL("jnf",float(*)(int,float))(3,x)-(float)jn(3,x))<2e-6f);
    assert(fabsf(CALL("ynf",float(*)(int,float))(3,x)-(float)yn(3,x))<2e-6f*fmaxf(1,fabsf((float)yn(3,x))));
  }
  struct {AndroidEnvironment value;uint64_t canary;} saved={.canary=UINT64_C(0xdeadbeef12345678)};
  assert(CALL("fegetenv",int(*)(AndroidEnvironment*))(&saved.value)==0);
  assert(saved.canary==UINT64_C(0xdeadbeef12345678));
  const int modes[]={0,1,2,3},hostModes[]={FE_TONEAREST,FE_UPWARD,FE_DOWNWARD,FE_TOWARDZERO};
  const double rounded[]={2,2,1,1};
  for(int i=0;i<4;i++){
    assert(CALL("fesetround",int(*)(int))(modes[i])==0);
    assert(CALL("fegetround",int(*)(void))()==modes[i]);
    assert(fegetround()==hostModes[i]);
    assert(CALL("nearbyint",double(*)(double))(1.5)==rounded[i]);
  }
  assert(CALL("fesetround",int(*)(int))(4)==-1);
  assert(CALL("fesetround",int(*)(int))(-1)==-1);
  assert(CALL("feclearexcept",int(*)(int))(0x9f)==0);
  assert(CALL("feraiseexcept",int(*)(int))(0x92)==0);
  assert(CALL("fetestexcept",int(*)(int))(0x9f)==0x92);
  uint32_t exceptions=0;
  assert(CALL("fegetexceptflag",int(*)(uint32_t*,int))(&exceptions,0x9f)==0&&exceptions==0x92);
  AndroidEnvironment held;
  assert(CALL("feholdexcept",int(*)(AndroidEnvironment*))(&held)==0);
  assert(CALL("fetestexcept",int(*)(int))(0x9f)==0);
  exceptions=1;assert(CALL("fesetexceptflag",int(*)(const uint32_t*,int))(&exceptions,1)==0);
  assert(CALL("feupdateenv",int(*)(const AndroidEnvironment*))(&held)==0);
  assert(CALL("fetestexcept",int(*)(int))(0x9f)==0x93);
  const AndroidEnvironment *defaults=lookup("__fe_dfl_env");assert(defaults&&defaults->control==0&&defaults->status==0);
  assert(CALL("fesetenv",int(*)(const AndroidEnvironment*))(defaults)==0);
  pthread_t threads[4];for(int i=0;i<4;i++)assert(pthread_create(&threads[i],NULL,round_worker,(void*)(intptr_t)i)==0);
  for(int i=0;i<4;i++)assert(pthread_join(threads[i],NULL)==0);
  assert(CALL("fegetround",int(*)(void))()==0);
  assert(CALL("fesetenv",int(*)(const AndroidEnvironment*))(&saved.value)==0);
  puts("PASS complete float/double namespace, original Bionic fallback functions, Android fenv and thread-local rounding");
}
