#include "lossless.hpp"
#include "lossless-version.hpp"
#include "mako-backend/dll_inspection.hpp"
#include "dll_reader.hpp"
#include <exception>
#include <iomanip>
#include <ostream>
#include <sstream>
namespace mako::backend { std::shared_ptr<const DllResourceArchive> loadVersionResourceArchive(const std::filesystem::path&); }
namespace {
std::string json(const std::string &text) {
 std::ostringstream out;out<<'"';
 for(unsigned char c:text){if(c=='"'||c=='\\')out<<'\\'<<c;else if(c<32)out<<"\\u"<<std::hex<<std::setw(4)<<std::setfill('0')<<unsigned(c);else out<<c;}
 out<<'"';return out.str();
}
std::string version(const char *path,const std::string &hash) {
 try {const auto archive=mako::backend::loadVersionResourceArchive(path);if(archive->fileSha256!=hash)return {};
  std::string result;for(const auto &item:archive->resources){auto current=macfx::losslessVersion(item.second);if(current.empty())continue;if(!result.empty()&&result!=current)return {};result=current;}return result;
 }catch(const std::exception &){return {};}
}
}
int macfx::inspectLossless(const char *path,std::ostream &output) {
 try {
  const auto value=mako::backend::inspectLosslessDll(path);const auto release=version(path,value.fileSha256);
  output<<"{\"schema\":1,\"version\":"<<(release.empty()?"null":json(release))<<",\"contentHash\":"<<json(value.fileSha256)<<",\"resourceLayoutHash\":"<<json(value.resourceLayoutSha256)<<",\"size\":"<<value.fileSize<<",\"resourceCount\":"<<value.resourceCount<<",\"capabilities\":{";
  bool first=true;auto capability=[&](const char *name,const auto &item){if(!first)output<<',';first=false;output<<json(name)<<":{\"compatible\":"<<(item.compatible?"true":"false")<<",\"reason\":"<<json(item.reason)<<'}';};
  capability("lsfgFp16Quality",value.lsfgFp16Quality);capability("lsfgFp16Performance",value.lsfgFp16Performance);capability("lsfgFp32Quality",value.lsfgFp32Quality);capability("lsfgFp32Performance",value.lsfgFp32Performance);capability("ls1Quality",value.ls1Quality);capability("ls1Performance",value.ls1Performance);
  output<<"}}\n";return 0;
 }catch(const std::exception &error){output<<"{\"schema\":1,\"error\":"<<json(error.what())<<"}\n";return 1;}
}
