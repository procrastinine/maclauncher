#pragma once
#include <cstdint>
#include <string>
#include <vector>
namespace macfx {
// VS_VERSION_INFO is binary data, never executable code. Missing or malformed
// optional version metadata does not determine shader compatibility.
inline std::string losslessVersion(const std::vector<uint8_t> &data) {
 auto word=[&](size_t i)->uint16_t{return uint16_t(data[i])|(uint16_t(data[i+1])<<8);};
 auto dword=[&](size_t i)->uint32_t{return uint32_t(word(i))|(uint32_t(word(i+2))<<16);};
 if(data.size()<6)return {};const size_t length=word(0);
 if(length>data.size()||length<6||word(2)<52||word(4)!=0)return {};
 size_t offset=6;const char key[]="VS_VERSION_INFO";
 for(char c:key){if(offset+2>length||word(offset)!=static_cast<unsigned char>(c))return {};offset+=2;}
 offset=(offset+3)&~size_t(3);
 if(offset+word(2)>length||dword(offset)!=0xfeef04bd||dword(offset+4)!=0x10000)return {};
 const uint32_t high=dword(offset+8),low=dword(offset+12);
 return std::to_string(high>>16)+"."+std::to_string(high&65535)+"."+std::to_string(low>>16)+"."+std::to_string(low&65535);
}
}
