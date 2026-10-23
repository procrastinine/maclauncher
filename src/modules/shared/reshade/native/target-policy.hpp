#pragma once
#include <cmath>
#include <cstdint>
#include <limits>
namespace targettime {
enum class Admission { Accept, Invalid, TooFar };
constexpr double maximumLead=1.0;
inline Admission admit(double target,double now) noexcept {
 if(!std::isfinite(target)||!std::isfinite(now)||now<=0)return Admission::Invalid;
 if(target>now&&target-now>maximumLead)return Admission::TooFar;
 return Admission::Accept;
}
// Decide only at actual presentation. Retain the caller's requested timestamp
// separately for API state and lateness accounting, including past/negative time.
inline bool schedule(double target,double decisionTime) noexcept {return target>decisionTime;}
inline unsigned bucket(double target,double actual) noexcept {
 const double delta=actual-target;
 if(delta<0)return 0;
 constexpr double limits[]={.001,.004,.008,.016,.032,.100};
 for(unsigned i=0;i<6;i++)if(delta<=limits[i])return i+1;
 return 7;
}
/* Signed Android nanos have the same origin as Mach only once the qualified
 * Android monotonic adapter is selected. Preserve the original integer state;
 * converting to Metal seconds introduces no arbitrary clock-offset guess. */
inline double seconds(int64_t nanoseconds) noexcept {return static_cast<double>(nanoseconds)/1e9;}
struct SurfaceTarget {
 bool set=false;int64_t nanos=0;
 void replace(int64_t value)noexcept{nanos=value;set=true;}
 void retire()noexcept{set=false;nanos=0;}
};
}
