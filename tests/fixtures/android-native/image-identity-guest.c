static int constructed;
__attribute__((constructor)) static void construct(void) { constructed++; }
int construction_count(void) { return constructed; }
