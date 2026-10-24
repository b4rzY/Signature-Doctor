# Connector protocol

This document describes the small read-only boundary between Signature Doctor and a process-inspection adapter. It is independent of a particular AngelScript embedding.

The included [`examples/angelscript-connect.as`](../examples/angelscript-connect.as) maps the protocol onto the supported host API subset. Another host can implement the same messages without changing the browser's catalog format or resolver engine.

## Connection

In direct mode, the adapter opens **`ws://127.0.0.1:3210/agent`** as a WebSocket client. The local server accepts one adapter at a time. Frames are UTF-8 JSON text, with one object per request or response.

The browser calls `POST /api/rpc` with `Content-Type: application/json`. The server validates the request, assigns a correlation ID for the adapter connection, and restores the caller's ID in the HTTP response. The adapter must echo the received integer `id` exactly.

`GET /api/connector` downloads the bundled `.as` adapter for the dashboard's **Download connector** action. Edit its target executable before loading it in the host.

Every successful response has type `<request type>_result`. Request failures may instead return `type: "error"`. A transport error, missing reply, or wrong response type is not an empty successful result.

```json
{ "type": "ping", "id": 17 }
```

```json
{
  "type": "ping_result",
  "id": 17,
  "attached": true,
  "pid": 1234,
  "base": "0x140000000",
  "protocol": "signature-doctor/1",
  "connector": "portable-angelscript",
  "capabilities": ["ping", "modules", "read", "read_batch", "sig_scan_ida", "resolve_relative"]
}
```

The numbers and addresses in this reference are illustrative. No live process observations are represented here.

### Capability advertisement

The portable adapter includes the protocol identifier and complete capability list in its `ping_result`. When these fields are present, the server requires `signature-doctor/1` and all six listed operations. An unsupported protocol or incomplete list fails explicitly. Operations outside an advertised list are not forwarded.

Legacy/native relay agents that omit the `protocol` field remain compatible with the original response shapes; their capabilities are not considered negotiated. `GET /api/status` reports known `protocol`, `connector`, and `capabilities` metadata after a ping, or `null` when unknown. Connection status is not a proof of host API compatibility.

## Required resolver operations

| Request | Purpose | Fields after `type` / `id` |
| --- | --- | --- |
| `ping` | Attachment and identity check | None |
| `modules` | Enumerate loaded modules | None |
| `read` | Read a bounded byte range | `address`, `size` |
| `read_batch` | Read several bounded ranges | `reads: [{ address, size }, ...]` |
| `sig_scan_ida` | Find every matching pattern in one module | `module`, `pattern`, `find_all: true` |
| `resolve_relative` | Resolve a four-byte signed relative displacement | `address`, `offset`, `inst_size` |

The current catalog engine uses five of these operations; `read_batch` is also part of the portable protocol's required advertised subset. Neither live debugging nor memory writes are required. The portable adapter does not advertise disassembly.

### Ping

An attached result contains a positive numeric `pid` and nonzero string `base`. If no process is attached, return `attached: false` and omit PID/base. Report the inspected target, not the process hosting the scripting engine.

The engine matches the module located at the reported process base to the catalog's expected `processName`. A network connection alone does not count as a valid attachment.

### Modules

Request:

```json
{ "type": "modules", "id": 18 }
```

Response:

```json
{
  "type": "modules_result",
  "id": 18,
  "success": true,
  "modules": [
    { "name": "MyApp.exe", "base": "0x140000000", "size": 4194304 },
    { "name": "engine.dll", "base": "0x180000000", "size": 2097152 }
  ]
}
```

Module names are filenames. Bases are hexadecimal strings; sizes are positive safe JSON integers. Empty, duplicate, zero-sized, or otherwise unusable module metadata prevents a reliable build check. Do not invent missing sizes or silently truncate 64-bit bases to JavaScript numbers.

### Read

Request:

```json
{ "type": "read", "id": 19, "address": "0x140002000", "size": 4 }
```

Response:

```json
{
  "type": "read_result",
  "id": 19,
  "success": true,
  "address": "0x140002000",
  "size": 4,
  "data": "2a000000"
}
```

`data` contains two hexadecimal digits per byte, without separators. A successful response must contain exactly the requested byte count. The engine decodes numeric values as little-endian.

On a failed read, return `success: false` with empty data, or an error envelope. Do not pad a partial read with zeros. Zero bytes can be valid data and must remain distinguishable from failure.

### Batched reads

```json
{
  "type": "read_batch",
  "id": 22,
  "reads": [
    { "address": "0x140002000", "size": 4 },
    { "address": "0x140002100", "size": 8 }
  ]
}
```

Return `type: "read_batch_result"` with a `results` array in request order. Every entry uses the individual read fields (`address`, `success`, `size`, `data`). The outer `success` reports that the batch was processed; it does not override an individual failed read.

### Signature scan

Request:

```json
{
  "type": "sig_scan_ida",
  "id": 20,
  "module": "MyApp.exe",
  "pattern": "48 8B 05 ?? ?? ?? ??",
  "find_all": true
}
```

Response:

```json
{
  "type": "sig_scan_ida_result",
  "id": 20,
  "success": true,
  "results": ["0x14001a2f0"]
}
```

Return **all matches**, not just the first one. With no matches, return `success: false` and `results: []`. An unavailable module, failed scan, or exhausted result limit should be reported distinctly rather than converted into a false unique match.

The engine rejects candidates outside the requested module and treats multiple distinct candidates as ambiguous. A result list must not be silently truncated into a one-element success.

### Relative reference

Request:

```json
{
  "type": "resolve_relative",
  "id": 21,
  "address": "0x14001a2f0",
  "offset": 3,
  "inst_size": 7
}
```

Response:

```json
{
  "type": "resolve_relative_result",
  "id": 21,
  "success": true,
  "address": "0x140002000"
}
```

The mathematical result is `address + inst_size + signed_int32(address + offset)`. Negative displacements are valid. Arithmetic must not wrap the unsigned 64-bit address range.

The engine also reads the displacement bytes and independently computes the expected result. A mismatch is a protocol/read failure. Relative resolution returns the referenced address; it does not implicitly dereference memory at that address.

## Error envelope

```json
{
  "type": "error",
  "id": 21,
  "code": "ReadFailed",
  "message": "Could not read the relative displacement."
}
```

The bridge accepts numeric or string error codes from adapters; `message` is the human-readable explanation. A bounded optional `detail` field may provide context. Avoid treating a host exception, unknown operation, detached process, or null read result as valid zero data.

## Bounds and lifecycle

| Boundary | Local server limit |
| --- | --- |
| HTTP JSON request body | 32 KiB |
| Adapter response frame / proxied JSON response | 2 MiB |
| One `read` | 1–65,536 bytes |
| One `read_batch` | 1–64 ranges, 256 KiB total |
| Signature | Up to 256 byte/wildcard tokens with at least one concrete byte |
| Signature result list | Portable adapter rejects more than 4,096 hits; it does not truncate into success |
| Module list | Up to 4,096 valid entries |
| Relative displacement | Offset 0–60, instruction size 4–64; the four-byte displacement must fit |
| Pending requests | 32 by default |
| Per-request timeout | 30 seconds by default; configurable through `RPC_TIMEOUT_MS` |

Unknown commands and unsupported request fields are rejected before forwarding. The protocol does not expose target-memory mutation, file execution, arbitrary callbacks, or a script-evaluation operation.

Disconnects reject outstanding requests. Cancellation stops waiting for the result and prevents a partial build report from being published; it does not guarantee preemption of a synchronous native scan already executing in the host.

The engine rechecks target PID, base, and the module list after resolving the catalog. An identity change discards the run. Separate successful reads are still sampled observations, not an atomic snapshot of a paused process.

## Existing relay

`WEB_MV_URL` selects a loopback `http://…/rpc` endpoint implementing the same request shapes. The server preserves its validation and read-only boundary before forwarding. The browser and catalog engine do not need to know whether a portable direct adapter or an existing relay produced the responses.

Use `npm start` for the normal loopback-bound application. Development preview mode is intended for local development infrastructure, not public exposure of process-inspection operations.
