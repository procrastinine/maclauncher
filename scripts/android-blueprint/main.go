// Developer-only JSON transport for the pinned upstream Blueprint parser.
// Parsing and expression evaluation belong to github.com/google/blueprint/parser.
package main

import (
 "encoding/json"
 "fmt"
 "os"
 "strings"
 "text/scanner"
 "unicode/utf16"

 "github.com/google/blueprint/parser"
)

type document struct { File string `json:"file"`; Source string `json:"source"`; Parents []document `json:"parents,omitempty"` }
type result struct {
 File string `json:"file"`
 Modules []any `json:"modules"`
 Assignments []any `json:"assignments"`
 Variables map[string]any `json:"variables"`
 Error string `json:"error,omitempty"`
}

func location(source string, pos scanner.Position) map[string]any {
 // Original parser offsets are UTF-8 bytes; the JS inventory uses UTF-16 units.
 offset := pos.Offset
 if offset < 0 || offset > len(source) { panic("invalid original parser position") }
 prefix := source[:offset]
 column := prefix[strings.LastIndex(prefix,"\n")+1:]
 return map[string]any{"file":pos.Filename,"line":pos.Line,"column":len(utf16.Encode([]rune(column)))+1,"offset":len(utf16.Encode([]rune(prefix))),"byteOffset":pos.Offset}
}

// Close over the original lexical scope when an expression moves to a derived
// package. The upstream parser still evaluates variables and operators; select
// conditions and pattern bindings remain for the original Soong evaluator.
func relocate(expression parser.Expression, scope *parser.Scope, bound map[string]bool) parser.Expression {
 switch x := expression.(type) {
 case *parser.Variable:
  if !bound[x.Name] { if evaluated, err := x.Eval(scope); err == nil { return relocate(evaluated,scope,bound) } }
 case *parser.Select:
  result:=x.Copy().(*parser.Select)
  if x.Scope!=nil { scope=x.Scope };result.Scope=nil
  for _, c:=range result.Cases {
   bindings:=make(map[string]bool,len(bound)+len(c.Patterns));for name:=range bound {bindings[name]=true}
   for _, pattern:=range c.Patterns { if pattern.Binding.Name!="" {bindings[pattern.Binding.Name]=true} }
   c.Value=relocate(c.Value,scope,bindings)
  }
  if result.Append!=nil { result.Append=relocate(result.Append,scope,bound) };return result
 case *parser.Operator:
  result:=x.Copy().(*parser.Operator);for i,arg:=range result.Args {result.Args[i]=relocate(arg,scope,bound)};return result
 case *parser.List:
  result:=x.Copy().(*parser.List);for i,item:=range result.Values {result.Values[i]=relocate(item,scope,bound)};return result
 case *parser.Map:
  result:=x.Copy().(*parser.Map);for _, property:=range result.Properties {property.Value=relocate(property.Value,scope,bound)};return result
 }
 return expression.Copy()
}

func value(expression parser.Expression, scope *parser.Scope) any {
 if evaluated, err := expression.Eval(scope); err == nil { expression = evaluated }
 switch x := expression.(type) {
 case *parser.String: return x.Value
 case *parser.Bool: return x.Value
 case *parser.Int64:
  if x.Value >= -9007199254740991 && x.Value <= 9007199254740991 { return x.Value }
 case *parser.List:
  values := make([]any,0,len(x.Values)); for _, item := range x.Values { values=append(values,value(item,scope)) }; return values
 case *parser.Map: return properties(x.Properties,scope)
 }
 expression=relocate(expression,scope,nil)
 text,err:=parser.PrintExpression(expression);if err!=nil {panic(err)}
 return map[string]any{"$expression":map[string]any{"kind":"original-blueprint","type":fmt.Sprintf("%T",expression),"ast":expression,"text":string(text)}}
}
func properties(input []*parser.Property, scope *parser.Scope) map[string]any {
 result:=make(map[string]any,len(input));for _, p:=range input { result[p.Name]=value(p.Value,scope) };return result
}
func parse(d document) result {
 output:=result{File:d.File,Modules:[]any{},Assignments:[]any{},Variables:map[string]any{}}
 original, errors:=parser.Parse(d.File,strings.NewReader(d.Source))
 if len(errors)>0 { output.Error=errors[0].Error();return output }
 var parent *parser.Scope
 for _, ancestor:=range d.Parents {
  scope:=parser.NewScope(parent)
  if _, errors:=parser.ParseAndEval(ancestor.File,strings.NewReader(ancestor.Source),scope);len(errors)>0 {output.Error=errors[0].Error();return output}
  parent=scope
 }
 scope:=parser.NewScope(parent)
 for _, definition:=range original.Defs {
  switch x:=definition.(type) {
  case *parser.Assignment:
   output.Assignments=append(output.Assignments,map[string]any{"name":x.Name,"operator":x.Assigner,"value":value(x.Value,scope),"location":location(d.Source,x.Pos())})
   // Ancestor-dependent assignments remain explicit; only upstream performs evaluation.
   assignment:=*x
   assignment.Value=x.Value.Copy()
   if err:=scope.HandleAssignment(&assignment);err==nil { output.Variables[x.Name]=value(scope.Get(x.Name).Value,scope) } else {
    output.Variables[x.Name]=map[string]any{"$expression":map[string]any{"kind":"original-blueprint-assignment","ast":x,"reason":err.Error()}}
   }
  case *parser.Module:
   output.Modules=append(output.Modules,map[string]any{"type":x.Type,"properties":properties(x.Properties,scope),"location":location(d.Source,x.Pos())})
  }
 }
 return output
}
func main() {
 var documents []document
 if err:=json.NewDecoder(os.Stdin).Decode(&documents);err!=nil {fmt.Fprintln(os.Stderr,err);os.Exit(1)}
 results:=make([]result,0,len(documents));for _, d:=range documents {results=append(results,parse(d))}
 if err:=json.NewEncoder(os.Stdout).Encode(results);err!=nil {fmt.Fprintln(os.Stderr,err);os.Exit(1)}
}
