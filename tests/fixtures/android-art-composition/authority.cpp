#include "../../../src/modules/android/art/native/composition-authority.hpp"
#include <iostream>
int main(){char enrolled;if(!klj_composition::readBytes(STDIN_FILENO,&enrolled,1)||enrolled!='1')return 7;std::array<std::string,6> fields;if(!klj_composition::readAuthority(STDIN_FILENO,fields))return 7;for(const auto&field:fields)std::cout<<field<<'\n';}
