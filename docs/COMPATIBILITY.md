# AngelScript host compatibility

Signature Doctor is an **AngelScript workbench with a portable host adapter**. AngelScript is the scripting language; the application embedding it registers APIs for process access, WebSockets, JSON, and lifecycle management. Those bindings are not part of the language itself.

The included adapter targets the shared process-inspection bindings documented by the two host profiles below. An unrelated AngelScript embedding needs equivalent bindings or a separate adapter implementing the [connector protocol](PROTOCOL.md).

## Supported host profiles

| Profile | API reference used | Connector | Runtime verification |
| --- | --- | --- | --- |
| **Echo** | Public [Process](https://echo-23.gitbook.io/angel/memory/process), [WebSocket](https://echo-23.gitbook.io/angel/networking/websocket), and JSON API documentation | `examples/angelscript-connect.as` | Compiler/VM fixtures passed with API-shaped stubs; no live installation test |
| **Solanius** | Full host API reference supplied by the repository owner for this compatibility update | The same `examples/angelscript-connect.as` | Compiler/VM fixtures passed with API-shaped stubs; no live installation test |

The owner-supplied reference was used to compare bindings and is not redistributed in this repository. The application does not infer compatibility from a host name. The adapter must load successfully, connect, attach to the intended process, and return valid module/read responses.

### Differences addressed by the adapter

| Area | Difference between the documented profiles | Approach |
| --- | --- | --- |
| Process socket | A built-in `process::open_socket` API is documented in one profile but absent from the supplied second profile. | Implement request handling in AngelScript over the shared `ws::connect` and `json::` APIs. No built-in socket dependency. |
| Attach signature | One profile documents one-argument attachment; the other declares `attach_window = true` as an optional second argument. | Call `process::attach(PROCESS_NAME)` using the shared form. |
| Attachment PID | The documented `attach_data.pid` widths differ. | Serialize the PID as an ordinary bounded process identifier; addresses stay 64-bit hexadecimal strings. |
| Memory-region metadata | Region flags and structure fields differ. | The resolver workflow does not use `virtual_query` or depend on those fields. |
| Module discovery | Hosts can differ in how module information is obtained and when it is available. | Require complete, nonzero module metadata and reject unusable target identity rather than manufacture a base or size. |
| Script location | The loaders use different directories. | Install the same source in the appropriate host directory listed below. |

### Script locations

| Host | Documented local script folder |
| --- | --- |
| Echo | `%APPDATA%\scripts` |
| Solanius | `%APPDATA%\Solanius\scripts` |

Follow the installed loader's refresh/load procedure after copying the file. Set the target executable in the connector before loading it. Do not copy a script into the data/config directory by mistake.

## Required bindings

The portable connector and generated resolvers use a narrow process-inspection subset. See the source for exact signatures.

| Binding group | Required capability |
| --- | --- |
| Process lifecycle | Attach by executable name, detach, check whether the target is alive, and obtain PID/base from `attach_data` |
| Modules | List modules; obtain module base and image size |
| Connector memory reads | `process::read_buffer`, a nullable `memory_buffer` handle, `memory_buffer::size`, and `memory_buffer::read_uint8`; a full-size buffer is required for success |
| Exported resolver reads | `process::read_bytes` plus success-reporting signed/unsigned integer and floating-point overloads such as `process::read_uint64(address, value)` |
| Pattern scanning | Find all IDA-style pattern matches in a module |
| Relative references | `process::read_int32(address, value)` for the signed displacement; the connector computes the checked target itself. Generated resolvers also use `process::get_relative_address` and cross-check it against the bytes. |
| JSON | Parse/stringify objects and arrays, inspect typed fields, and build result messages |
| WebSocket | Connect, send, disconnect, and receive callbacks |
| Script lifecycle | `bool main()` and an unload callback |
| Connection menu | `ui::add_tab`, `ui::add_category`, `ui::add_button`, and callback handles |
| Synchronization / diagnostics | `create_mutex` with lock/unlock and script-console `print` |

The adapter also uses the host's normal `string` and `array` registrations. It does not require a disassembler, emulator, native debugger, target-memory allocation, or target-memory writes.

Generated `.as` resolver exports use the process API subset directly. They do not require a running dashboard or WebSocket connection after export. Their standalone entrypoint should be merged carefully when incorporating the helpers into a larger existing script.

## Direct mode and existing-relay mode

**Direct mode:** the portable adapter implements the protocol and opens a WebSocket to `ws://127.0.0.1:3210/agent`. One direct adapter is accepted at a time by a Signature Doctor server. Load the connector once for the intended target.

**Existing-relay mode:** configure `WEB_MV_URL` to reuse a working web-mv relay. Signature Doctor sends the same bounded requests through its HTTP endpoint and does not load a second direct connector. The compatibility of that relay's own host integration remains the relay's responsibility.

A generic WebSocket connection being open does not prove that the process is attached. The build check verifies target identity and module metadata before resolving recipes.

## Verification scope

Automated JavaScript tests cover catalog validation, resolver behavior, comparison, the transport, review gates, generated-code contracts, and interface interactions. Simulated agents exercise the wire protocol without a live target.

API signatures have been compared against the documented host profiles. **Eight fixture runs passed using the real AngelScript 2.38.0 compiler and virtual machine:** three generated-resolver suites plus portable-connector dispatch, each under two API-shaped stub profiles.

Those fixtures exercise all ten numeric types, exact 64-bit bounds, negative rel32, 32/64-bit pointer chains, ambiguous signatures, failed and short reads, NaN, zero-on-failure behavior, float32 comparison boundaries, protocol dispatch, and connector teardown. The tested source is the actual generated resolver output and included portable connector.

**The host behavior is synthetic.** These runs do not implement or verify native JSON parsing/serialization, real threads, networking, module discovery, or process-memory access. They establish language/signature compatibility and fixture behavior; they do not prove that either proprietary host installation behaves identically. Neither live installation has been exercised here.

### Reproduce the compiler/VM checks

Use Node.js, an installed AngelScript **2.38.0** SDK, and a GNU-compatible C++17 compiler (`g++` by default, or set `CXX`). The SDK and compiler are optional development tools, not application runtime dependencies.

```bash
node scripts/verify-angelscript.mjs --sdk /path/to/sdk
```

Alternatively, set `ANGELSCRIPT_SDK` to that SDK directory. The helper rejects other SDK versions, builds its test runner under ignored `tmp/`, and runs the fixtures in [`tests/angelscript/`](../tests/angelscript/). These native compiler checks are separate from the Node-only `npm run verify` suite.

Browser visual QA was unavailable in the build environment because the managed preview service could not start. The README image is an explicitly labeled interface illustration generated from the implementation and simulated fixture data.

### Installation smoke check

1. Start the server and load the portable connector in the intended host.
2. Confirm the script attaches and the dashboard reports a runtime connection.
3. Create a small catalog with the exact process/module names from that installation.
4. Check one known readable address, then deliberately fail one validation to verify the error path.
5. Check a known signature and confirm that ambiguous matches are rejected.
6. Review one passing item, export `.as`, and compile/run it in the installed host.
7. Stop the target and confirm that a new check fails without publishing a mixed or partial run.

If a host version changes a binding, update the adapter at this boundary and retain the catalog/protocol semantics. Do not silently replace a success-reporting read with an overload that returns zero on failure.
