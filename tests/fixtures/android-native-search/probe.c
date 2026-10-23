#include <assert.h>
#include <search.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void* klj_search_lookup(const char*);
static int compare(const void* a,const void* b){return (*(const int*)a>*(const int*)b)-(*(const int*)a<*(const int*)b);}
static int visited,freed;
static void visit(const void* node,VISIT order,int depth){assert(node&&depth>=0);if(order==postorder||order==leaf)visited++;}
static void destroy(void* key){free(key);freed++;}
struct link {struct link* next;struct link* previous;int value;};

int main(void){
  const char* names[]={"insque","remque","hcreate","hdestroy","hsearch","hcreate_r","hdestroy_r","hsearch_r","lfind","lsearch","tdelete","tdestroy","tfind","tsearch","twalk"};
  for(size_t i=0;i<sizeof(names)/sizeof(*names);i++)assert(klj_search_lookup(names[i]));
  struct link a={0},b={0},c={0};insque(&a,NULL);insque(&b,&a);insque(&c,&a);
  assert(a.next==&c&&c.next==&b&&b.previous==&c);remque(&c);assert(a.next==&b&&b.previous==&a);
  int array[16]={1,3,5},key=3;size_t count=3;
  assert(lfind(&key,array,&count,sizeof(int),compare)==array+1);
  key=8;assert(!lfind(&key,array,&count,sizeof(int),compare));assert(lsearch(&key,array,&count,sizeof(int),compare)==array+3);assert(count==4&&array[3]==8);
  void* tree=NULL;for(int n=0;n<257;n++){int* value=malloc(sizeof(int));*value=(n*73)%257;assert(tsearch(value,&tree,compare));}
  twalk(tree,visit);assert(visited==257);
  key=53;int** found=tfind(&key,&tree,compare);assert(found&&**found==53);int* owned=*found;assert(tdelete(&key,&tree,compare));free(owned);assert(!tfind(&key,&tree,compare));
  tdestroy(tree,destroy);assert(freed==256);
  assert(hcreate(1));ENTRY entry={"global",(void*)41};assert(hsearch(entry,ENTER)->data==(void*)41);assert(hsearch(entry,FIND)->data==(void*)41);hdestroy();
  struct hsearch_data tables[2]={{0},{0}};char keys[512][16];
  for(int t=0;t<2;t++)assert(hcreate_r(1,&tables[t]));
  for(int i=0;i<512;i++){snprintf(keys[i],sizeof(keys[i]),"key-%d",i);for(int t=0;t<2;t++){ENTRY insert={keys[i],(void*)(uintptr_t)(i+1+t*1000)},*result=NULL;assert(hsearch_r(insert,ENTER,&result,&tables[t]));assert(result->data==insert.data);}}
  for(int i=511;i>=0;i--)for(int t=0;t<2;t++){ENTRY query={keys[i],NULL},*result=NULL;assert(hsearch_r(query,FIND,&result,&tables[t]));assert(result->data==(void*)(uintptr_t)(i+1+t*1000));}
  for(int t=0;t<2;t++)hdestroy_r(&tables[t]);
  puts("PASS complete original search family: queue, linear, tree, independent growing hash tables");
}
