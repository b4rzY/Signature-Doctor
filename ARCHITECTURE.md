# Architecture

Signature Doctor separates editable definitions, sampled observations, and explicit review decisions.

## Components

| Component | Responsibility |
| --- | --- |
| Browser UI | Catalog editing, mode selection, progress, evidence inspection, baseline selection, local history, approval, downloads |
| `shared/catalog.mjs` | Strict input normalization, bounded schemas, exact address parsing, stable definition fingerprints |
| `shared/engine.mjs` | Resolver execution, validation, comparison, cancellation, target consistency |
| `shared/demo.mjs` | Synthetic RPC target consumed by the same engine |
| `shared/export.mjs` | Approval gates, reviewed manifests, generated AngelScript recipes |
| Node server | Static application delivery and a bounded read-only RPC transport |
| Echo / web-mv | Process attachment, memory access, module enumeration, and pattern operations |

The application uses native ES modules in both Node and the browser. No transpilation or frontend build step is needed.

## A check, from start to finish

```mermaid
sequenceDiagram
    participant UI as Dashboard
    participant Engine as Resolver engine
    participant Bridge as Local bridge
    participant Echo as Echo process API
    UI->>Engine: Catalog, baseline, mode, cancellation signal
    Engine->>Bridge: Ping and enumerate modules
    Bridge->>Echo: Correlated read-only requests
    Echo-->>Engine: Target identity and module list
    loop Each enabled catalog item
        Engine->>Bridge: Resolve, read and validate
        Bridge->>Echo: Bounded request
        Echo-->>Engine: Response with success or error
        Engine-->>UI: Progress and item evidence
    end
    Engine->>Bridge: Recheck target and module identity
    Bridge->>Echo: Ping and enumerate modules
    Echo-->>Engine: Current identity
    alt Target identity unchanged
        Engine-->>UI: Completed report
    else Detached, replaced or changed modules
        Engine-->>UI: Reject run; do not publish mixed observations
    end
```

The process continues to execute during a check. Even unchanged target identity cannot turn separate reads into an atomic snapshot. A result expresses the observations and validations recorded during that run.

## Address correctness

Runtime address arithmetic uses `BigInt`. Addresses and 64-bit values cross JSON boundaries as strings. Operations guard underflow, overflow, null pointers, incomplete reads, and out-of-module source RVAs.

Signature scanning requests every match. Relative references are validated against a signed four-byte displacement. Pointer chains use a documented dereference-then-add convention. No ambiguous scan candidate is automatically accepted.

Comparison uses module-relative locations when stable module membership exists. Source RVAs remain available for pointer recipes whose final objects live on a changing heap. Target-generation and definition differences are kept separate from a genuine moved module offset.

## Transport

### Direct mode

Echo's `process::open_socket` connects to `/agent`. The server assigns its own request IDs, tracks pending callers, correlates responses, and rejects pending work on disconnect or timeout. Only one direct agent is accepted.

### Existing-relay mode

`WEB_MV_URL` selects an existing loopback HTTP RPC endpoint. The same read-only request gate remains in front of that endpoint. The application does not open a second Echo process socket in this mode.

### Request boundaries

The server validates request shapes, addresses, sizes, patterns, and allowed operations. Target-memory writes and arbitrary host commands are not part of the protocol. HTTP requests use same-origin checks and bounded JSON bodies; static files are confined to the application directories. Normal startup binds to `127.0.0.1`.

This server is intended for the user's local machine. Development mode listens on all interfaces for preview tooling and should not be used as a public deployment configuration.

## State and review

Catalog definitions and the latest 20 completed runs are stored in browser-local storage. Approvals belong to a specific run. Catalog/run/report downloads let the user retain files outside that browser profile. Clearing browser site data removes local history.

Export requires:

1. A completed run for the same catalog and current catalog fingerprint.
2. Explicitly selected, unique entry IDs.
3. An enabled item with a `valid` or `moved` result.
4. The current item-definition fingerprint and passing validation evidence.
5. Live mode for AngelScript output.

The exporter copies approved resolver recipes and observed evidence into JSON. It generates fresh runtime resolution logic for AngelScript and never substitutes a captured heap address for a recipe. Review fingerprints are change detectors, not cryptographic attestations that imported observations are trustworthy.

## Generated AngelScript

Each generated resolver starts with the current module base, performs its recipe, repeats all validation checks, and returns success plus the resolved address. A shared helper checks signed offset arithmetic. Relative displacements are read with a success-reporting signed read and cross-checked with the documented API helper.

`sd_resolve_all()` clears published globals, stages every result, checks process/module liveness again, and only then publishes all addresses together. The standalone `main()` attaches using the current documented one-argument API. Consumers incorporating helpers into existing scripts should merge the entrypoint and rerun resolution after reattachment or target changes.

Tests verify generation contracts and export gates. The repository does not contain an Echo host or AngelScript compiler, so runtime compilation and real-target correctness must be verified against the installed Echo version.

## Testing strategy

- Schema tests exercise rejected malformed input, bounds, and precision-preserving normalization.
- Resolver tests use controlled memory responses to cover uniqueness, missing matches, pointer chains, rel32, zero versus failure, ASLR, definition changes, and target changes.
- Export tests cover review eligibility, stale definitions, demo separation, exact numeric bounds, and generated validation behavior.
- Transport tests use a synthetic WebSocket agent for multiplexing, disconnects, invalid requests, and origin/path boundaries.

No automated test claims to establish live Echo compatibility. A real installation smoke check should connect the supplied script, verify the listed modules, resolve a known address, confirm an expected validation failure, and compile one small reviewed export.
