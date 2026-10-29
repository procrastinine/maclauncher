#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <memory>
#include <mutex>
namespace macfx {
// Records only original SDK history decisions, never an SDK/command object.
// A later nonreset encode pins its predecessor's original GPU history before
// that predecessor can be omitted. A genuinely omitted predecessor requires
// an exact reset when the original SDK next records a fallback/resume.
class Metal4SdkHistory {
public:
 struct Ticket {bool reset=false,required=false;enum Decision {Pending,Original,Omitted}decision=Pending;};
private:
 std::mutex mutex;std::shared_ptr<Ticket>previous;bool linked=false;
public:
 std::shared_ptr<Ticket>begin(bool requestedReset){std::lock_guard guard(mutex);auto last=previous;auto next=std::make_shared<Ticket>();next->reset=requestedReset||(last&&last->decision==Ticket::Omitted);if(last&&last->decision==Ticket::Pending&&!requestedReset)last->required=true;previous=next;return next;}
 void original(const std::shared_ptr<Ticket>&ticket){std::lock_guard guard(mutex);ticket->decision=Ticket::Original;}
 void abandoned(const std::shared_ptr<Ticket>&ticket){std::lock_guard guard(mutex);if(ticket->decision==Ticket::Pending)ticket->decision=Ticket::Omitted;}
 bool omit(const std::shared_ptr<Ticket>&ticket){std::lock_guard guard(mutex);if(linked||ticket->required||ticket->decision!=Ticket::Pending)return false;ticket->decision=Ticket::Omitted;return true;}
 bool mayOmit(const std::shared_ptr<Ticket>&ticket){std::lock_guard guard(mutex);return !linked&&!ticket->required&&ticket->decision==Ticket::Pending;}
 void linkedScaler(){std::lock_guard guard(mutex);linked=true;if(previous)previous->required=true;}
};
}
