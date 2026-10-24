# Real AngelScript compiler and VM checks

This optional suite compiles generated resolvers and the portable connector with the **real AngelScript 2.38.0 compiler**, then executes assertions against synthetic API-shaped fixtures for both supported hosts.

It requires **Node.js 22+** and a **GCC-compatible C++17 compiler** (`g++` by default; override with `CXX`). It was executed with GCC on Linux. The regular `npm run verify` remains Node-only; the SDK is not an application dependency.

## Reproduce

Fetch the official SDK source at its pinned release:

```sh
git clone --depth 1 --branch v2.38.0 https://github.com/anjo76/angelscript.git tmp/angelscript-sdk
git -C tmp/angelscript-sdk rev-parse HEAD
```

The second command must print:

```text
0601da029d846a658bf23f2888e953a45a94450a
```

Then run:

```sh
npm run verify:angelscript -- --sdk tmp/angelscript-sdk/sdk
```

An existing installation can instead be selected with `ANGELSCRIPT_SDK`. The helper checks that its header reports exactly version `2.38.0`. It compiles native objects and fixtures beneath ignored `tmp/angelscript-check/`; no SDK sources or binaries are included in this repository. Subsequent invocations reuse compiled objects.

Official source: [anjo76/angelscript at the pinned commit](https://github.com/anjo76/angelscript/tree/0601da029d846a658bf23f2888e953a45a94450a). AngelScript is distributed under its upstream zlib-style license.

## What runs

Each host profile has four compiler/VM runs, **eight runs total**:

| Fixture | Assertions |
| --- | --- |
| Generated resolvers | Ten numeric types, exact 64-bit extrema, byte patterns, alignment, module membership, negative relative displacement, signed pointer offsets, ambiguous matches, read failure and partial reads, NaN, overflow, and zeroed output after failure |
| 32-bit pointers | Correct dereferencing, signed offsets, and null-pointer rejection |
| Float32 boundary | Comparison against a precise double-precision bound agrees with the dashboard |
| Portable connector | Exact decimal/hexadecimal address parsing, refreshed PID, module output, valid zero versus failed reads, bounded batch results, all-match scanning, signed rel32 resolution, rejection of mutation commands, and disconnect cleanup |

`host-echo.as` and `host-solanius.as` intentionally model the documented differences in `attach_data.pid` width and the optional second `process::attach` parameter. The remaining stubs expose the shared bindings used by the production scripts.

## Verification boundary

These checks verify real AngelScript syntax, type checking, and execution semantics. **They do not load Echo or Solanius**, inspect a real process, or validate a proprietary host's native bindings. JSON parsing/serialization, native threading, UI rendering, and network transport are not simulated by these fixtures. Connector dispatch is exercised directly with in-memory JSON objects.

Run the documented live-host smoke checks separately before relying on a particular installed host version or target application.
