#pragma once
#include "spirv.hpp"
#include "spirv_msl.hpp"
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace macfx {
// SPIRV-Cross localizes all module Workgroup variables into each Metal entry
// point, including variables used only by a different compute entry point.
// Its active-interface query intentionally excludes this storage class. Keep
// the IR intact, but omit dead declarations from that localization list.
class EffectMSLCompiler : public spirv_cross::CompilerMSL {
public:
    using spirv_cross::CompilerMSL::CompilerMSL;
    void pruneInactiveWorkgroups() {
        const auto model=get_execution_model();
        if(model!=spv::ExecutionModelVertex&&model!=spv::ExecutionModelFragment)return;
        struct References : OpcodeHandler {
            std::set<uint32_t> used,functions;
            explicit References(EffectMSLCompiler &compiler):OpcodeHandler(compiler){}
            bool handle(spv::Op,const uint32_t *args,uint32_t length) override {
                // Conservatively count every operand: a literal matching an ID
                // may retain a declaration, but cannot hide a real reference.
                used.insert(args,args+length);return true;
            }
            bool follow_function_call(const spirv_cross::SPIRFunction &function) override {
                return functions.insert(function.self).second;
            }
            bool handle_terminator(const spirv_cross::SPIRBlock &block) override {
                used.insert(block.return_value);used.insert(block.condition);
                for(const auto &phi:block.phi_variables){used.insert(phi.local_variable);used.insert(phi.function_variable);}
                return true;
            }
        } references(*this);
        references.functions.insert(ir.default_entry_point);
        traverse_all_reachable_opcodes(get<spirv_cross::SPIRFunction>(ir.default_entry_point),references);
        // Also preserve variables referenced by a module-scope initializer.
        ir.for_each_typed_id<spirv_cross::SPIRVariable>([&](uint32_t,const spirv_cross::SPIRVariable &variable){
            if(variable.initializer)references.used.insert(variable.initializer);
        });
        for(auto it=global_variables.begin();it!=global_variables.end();){
            const auto &variable=get<spirv_cross::SPIRVariable>(*it);
            if(variable.storage==spv::StorageClassWorkgroup&&!references.used.count(*it))it=global_variables.erase(it);
            else ++it;
        }
    }
};
// ReShade accepts HLSL integer matrices and shortened SV_Position parameters.
// Express them using portable SPIR-V types before either backend translates:
// integer matrices are column arrays; FragCoord is float4 with an explicit
// truncation on load. No shader-source or generated-text replacements occur.
inline std::vector<uint32_t> portableEffectSPIRV(const std::vector<uint32_t> &words) {
    struct Type {spv::Op op;uint32_t element=0,count=0;};
    std::map<uint32_t,Type> types;
    std::map<uint32_t,uint32_t> variables,positions;
    std::set<uint32_t> builtins;
    if(words.size()<5)throw std::runtime_error("Invalid effect SPIR-V module");
    for(size_t at=5;at<words.size();){
        const auto count=words[at]>>16;const auto op=spv::Op(words[at]&65535);const auto *p=words.data()+at;
        if(!count||count>words.size()-at)throw std::runtime_error("Invalid effect SPIR-V instruction");
        if(op==spv::OpTypeInt||op==spv::OpTypeFloat)types[p[1]]={op,0,p[2]};
        else if(op==spv::OpTypeVector||op==spv::OpTypeMatrix)types[p[1]]={op,p[2],p[3]};
        else if(op==spv::OpTypePointer)types[p[1]]={op,p[3],p[2]};
        else if(op==spv::OpVariable)variables[p[2]]=p[1];
        else if(op==spv::OpDecorate&&count>=4&&p[2]==spv::DecorationBuiltIn&&p[3]==spv::BuiltInFragCoord)builtins.insert(p[1]);
        at+=count;
    }
    for(auto id:builtins){
        const auto variable=variables.find(id);if(variable==variables.end())continue;
        const auto pointer=types.at(variable->second),value=types.at(pointer.element);
        if(pointer.count!=spv::StorageClassInput)continue;
        if(value.op==spv::OpTypeFloat)positions[id]=pointer.element;
        else if(value.op==spv::OpTypeVector&&value.count<4&&types.at(value.element).op==spv::OpTypeFloat)positions[id]=pointer.element;
    }
    std::vector<uint32_t> result(words.begin(),words.begin()+5);
    uint32_t next=words[3];
    std::map<uint32_t,std::pair<uint32_t,uint32_t>> positionTypes;
    auto emit=[&](spv::Op op,std::initializer_list<uint32_t> args){result.push_back((uint32_t(args.size()+1)<<16)|uint32_t(op));result.insert(result.end(),args);};
    for(size_t at=5;at<words.size();){
        const auto count=words[at]>>16;const auto op=spv::Op(words[at]&65535);const auto *p=words.data()+at;
        bool handled=false;
        if(op==spv::OpTypeMatrix){
            const auto vector=types.at(p[2]);
            if(types.at(vector.element).op==spv::OpTypeInt){
                const uint32_t length=next++;emit(spv::OpConstant,{vector.element,length,p[3]});
                emit(spv::OpTypeArray,{p[1],p[2],length});handled=true;
            }
        } else if(op==spv::OpVariable&&positions.count(p[2])){
            const auto original=types.at(positions.at(p[2]));
            const uint32_t scalar=original.op==spv::OpTypeFloat?positions.at(p[2]):original.element;
            auto found=positionTypes.find(scalar);
            if(found==positionTypes.end()){
                const uint32_t vector=next++,pointer=next++;
                emit(spv::OpTypeVector,{vector,scalar,4});emit(spv::OpTypePointer,{pointer,spv::StorageClassInput,vector});
                found=positionTypes.emplace(scalar,std::make_pair(vector,pointer)).first;
            }
            result.insert(result.end(),p,p+count);result[result.size()-count+1]=found->second.second;handled=true;
        } else if(op==spv::OpLoad&&positions.count(p[3])){
            const auto original=types.at(positions.at(p[3]));
            const uint32_t scalar=original.op==spv::OpTypeFloat?positions.at(p[3]):original.element;
            const uint32_t vector=positionTypes.at(scalar).first,temporary=next++;
            result.insert(result.end(),p,p+count);result[result.size()-count+1]=vector;result[result.size()-count+2]=temporary;
            if(original.op==spv::OpTypeFloat)emit(spv::OpCompositeExtract,{p[1],p[2],temporary,0});
            else {result.push_back(((5+original.count)<<16)|uint32_t(spv::OpVectorShuffle));result.insert(result.end(),{p[1],p[2],temporary,temporary});for(uint32_t i=0;i<original.count;++i)result.push_back(i);}
            handled=true;
        }
        if(!handled)result.insert(result.end(),p,p+count);
        at+=count;
    }
    result[3]=next;return result;
}
template<class Compiler> inline void namespaceEffectFunctions(Compiler &compiler,const std::vector<uint32_t> &words){
    std::set<uint32_t> entries;
    for(size_t at=5;at<words.size();at+=words[at]>>16)if(spv::Op(words[at]&65535)==spv::OpEntryPoint)entries.insert(words[at+2]);
    for(size_t at=5;at<words.size();at+=words[at]>>16)if(spv::Op(words[at]&65535)==spv::OpFunction&&!entries.count(words[at+2]))
        compiler.set_name(words[at+2],"RSFunction"+std::to_string(words[at+2]));
}
}
