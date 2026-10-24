// Compile and execute fixtures with the real AngelScript VM and synthetic API stubs.
// This runner never attaches to a process or calls a proprietary host runtime.
#include "angelscript.h"
#include "scriptarray.h"
#include "scriptstdstring.h"
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

static void Message(const asSMessageInfo *msg, void *) {
  std::cerr << msg->section << ':' << msg->row << ':' << msg->col << ' '
            << (msg->type == asMSGTYPE_ERROR ? "error" : msg->type == asMSGTYPE_WARNING ? "warning" : "info")
            << ": " << msg->message << '\n';
}
static void Print(asIScriptGeneric *gen) { std::cout << *static_cast<std::string *>(gen->GetArgObject(0)) << '\n'; }
static void FloatBits(asIScriptGeneric *gen) { asDWORD bits = gen->GetArgDWord(0); float value; std::memcpy(&value, &bits, 4); gen->SetReturnFloat(value); }
static void DoubleBits(asIScriptGeneric *gen) { asQWORD bits = gen->GetArgQWord(0); double value; std::memcpy(&value, &bits, 8); gen->SetReturnDouble(value); }
static void Timeout(asIScriptContext *ctx, void *start) {
  const auto elapsed = std::chrono::steady_clock::now() - *static_cast<std::chrono::steady_clock::time_point *>(start);
  if (elapsed > std::chrono::seconds(10)) ctx->Abort();
}
int main(int argc, char **argv) {
  if (argc < 2) { std::cerr << "Usage: runner section.as [section.as ...]\n"; return 1; }
  asIScriptEngine *engine = asCreateScriptEngine();
  engine->SetMessageCallback(asFUNCTION(Message), nullptr, asCALL_CDECL);
  RegisterStdString(engine);
  RegisterScriptArray(engine, true);
  if (engine->RegisterGlobalFunction("void print(string)", asFUNCTION(Print), asCALL_GENERIC) < 0 ||
      engine->RegisterGlobalFunction("float fixture_float(uint)", asFUNCTION(FloatBits), asCALL_GENERIC) < 0 ||
      engine->RegisterGlobalFunction("double fixture_double(uint64)", asFUNCTION(DoubleBits), asCALL_GENERIC) < 0) return 2;
  asIScriptModule *module = engine->GetModule("fixture", asGM_ALWAYS_CREATE);
  for (int i = 1; i < argc; i++) {
    std::ifstream file(argv[i]);
    if (!file) { std::cerr << "Cannot read " << argv[i] << '\n'; return 2; }
    std::stringstream data; data << file.rdbuf();
    const std::string source = data.str();
    module->AddScriptSection(argv[i], source.c_str(), source.size());
  }
  if (module->Build() < 0) { engine->ShutDownAndRelease(); return 3; }
  asIScriptFunction *entry = module->GetFunctionByDecl("bool test_main()");
  if (!entry) { std::cerr << "Missing required bool test_main() fixture entry\n"; engine->ShutDownAndRelease(); return 2; }
  asIScriptContext *context = engine->CreateContext();
  auto start = std::chrono::steady_clock::now();
  context->SetLineCallback(asFUNCTION(Timeout), &start, asCALL_CDECL);
  context->Prepare(entry);
  const int state = context->Execute();
  int status = 0;
  if (state != asEXECUTION_FINISHED) {
    std::cerr << "Execution failed (state " << state << ")";
    if (state == asEXECUTION_EXCEPTION) std::cerr << ": " << context->GetExceptionString() << " at line " << context->GetExceptionLineNumber();
    std::cerr << '\n'; status = 4;
  } else if (!context->GetReturnByte()) { std::cerr << "Fixture assertions returned false\n"; status = 5; }
  else std::cout << "PASS — AngelScript " << asGetLibraryVersion() << " compiled and executed the fixture\n";
  context->Release(); engine->ShutDownAndRelease(); return status;
}
