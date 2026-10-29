// Copyright (c) MacLauncher contributors. MIT license.
#pragma once
#include "effect-node.hpp"
#include <functional>
namespace macfx {
// Owned, synchronous companion. Optional provider frame/spec/vtable ABIs do
// not change. Identity describes the pixels entering this exact shader row.
struct ShaderHistoryInput {
 uint64_t contentId=0,epoch=1,imageRevision=0;
 // As in NeuralInputStamp: the exact input, and the input contract that
 // history continues across (empty means inputIdentity).
 std::string inputIdentity,historyIdentity;
 bool synthetic=false,redraw=false,reset=false;
 const std::string&history()const noexcept{return historyIdentity.empty()?inputIdentity:historyIdentity;}
};
class ShaderHistoryScope {
 const ShaderHistoryInput*previous=nullptr;
public:
 explicit ShaderHistoryScope(const ShaderHistoryInput*);
 ~ShaderHistoryScope();
 ShaderHistoryScope(const ShaderHistoryScope&)=delete;
 ShaderHistoryScope&operator=(const ShaderHistoryScope&)=delete;
};
std::shared_ptr<ShaderNode>coreShaderWithRealHistory(const std::shared_ptr<ShaderNode>&,bool);
std::function<ShaderResult()>coreShaderHistoryCompletionTicket(const std::shared_ptr<ShaderNode>&);
}
