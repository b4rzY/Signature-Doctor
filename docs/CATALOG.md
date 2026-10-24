# Catalog reference

A catalog is a versioned JSON document describing **how to find and validate** named addresses. Save recipes rather than absolute addresses from a previous attachment.

Catalogs describe the inspected application and are independent of the scripting host's brand. `processName` is the target executable, not the loader or the process embedding AngelScript. Live access requires a compatible [host adapter](COMPATIBILITY.md).

## Document

```json
{
  "schemaVersion": 1,
  "id": "my-project",
  "name": "My project",
  "processName": "MyApp.exe",
  "items": []
}
```

| Property | Meaning |
| --- | --- |
| `schemaVersion` | Must be `1`. |
| `id` | Stable project identifier, 1–64 characters: letters, digits, `.`, `_`, `-`. |
| `name` | Display name, up to 96 characters. |
| `processName` | Expected main executable filename, checked against the module at the attached process base. Also used by generated AngelScript. |
| `items` | Up to 250 named resolver definitions. |

## Common item properties

```json
{
  "id": "object-count",
  "name": "ObjectCount",
  "module": "MyApp.exe",
  "kind": "rva",
  "rva": "0x4200",
  "addend": "0x0",
  "checks": [{ "type": "range", "dataType": "u32", "min": "0", "max": "10000" }],
  "notes": "Established against the development build.",
  "enabled": true
}
```

IDs and names must be unique within a catalog. `addend` defaults to `"0x0"`, `checks` to an empty list, and `enabled` to `true`. A final address always receives at least a one-byte readability probe if no explicit `readable` check is configured.

**All addresses, offsets, addends, and numeric range bounds are strings.** This preserves 64-bit values through JSON and the browser. Numbers such as `18446744073709551615` cannot be represented exactly by JavaScript's `Number`; use `"18446744073709551615"` instead.

Unsigned addresses accept decimal or `0x` hexadecimal strings. Signed offsets also accept forms such as `"-16"` and `"-0x10"`. Normalized addresses use lowercase hexadecimal; signatures use uppercase byte pairs and `??` wildcards.

## Resolver kinds

### Module-relative address: `rva`

```json
{
  "id": "settings",
  "name": "Settings",
  "module": "MyApp.exe",
  "kind": "rva",
  "rva": "0x3100",
  "addend": "0x8",
  "checks": [{ "type": "readable", "size": 16 }]
}
```

The source is `module.base + rva`; then `addend` is applied. The source RVA must lie within the module. Use an `in_module` check if the final address must also stay inside a particular module.

### Signature: `signature`

```json
{
  "id": "camera-reference",
  "name": "CameraReference",
  "module": "MyApp.exe",
  "kind": "signature",
  "pattern": "48 8B 05 ?? ?? ?? ?? 48 85 C0",
  "relative": { "offset": 3, "instructionSize": 7 },
  "addend": "0x0",
  "checks": [{ "type": "readable", "size": 8 }]
}
```

The engine requests **all** matches in the named module. Zero matches are missing; multiple matches are ambiguous. It never chooses the first of multiple candidates.

`relative` is optional. When supplied, it treats four bytes at `match + offset` as a signed little-endian displacement and resolves `match + instructionSize + displacement`. The engine verifies the remote resolution against the bytes it read. `addend` is applied afterward.

A referenced address containing a pointer is still the address of that pointer. Relative resolution does not automatically dereference it.

Accepted pattern tokens are complete hexadecimal byte pairs and `?`/`??` wildcards. Nibble wildcards such as `4?` are not supported. At least one concrete byte is required.

### Pointer chain: `pointer`

```json
{
  "id": "active-object",
  "name": "ActiveObject",
  "module": "MyApp.exe",
  "kind": "pointer",
  "rva": "0x6000",
  "pointerSize": 8,
  "offsets": ["0x20", "-0x8", "0x10"],
  "addend": "0x0",
  "checks": [{ "type": "readable", "size": 32 }]
}
```

The algorithm is precise:

1. Start at `address = module.base + rva`.
2. For each offset, read the pointer stored at `address`, then calculate `address = pointer + offset`.
3. Apply the final `addend`.
4. Run validation checks at the final address.

Every hop requires a complete successful read and a nonzero pointer. `pointerSize` is `4` or `8` bytes and defaults to `8`. The first version uses a module-relative root for pointer chains; a signature-rooted chain is not a supported catalog shape.

## Validation checks

All configured checks must pass. An empty check list establishes readability only, not object identity.

| Type | Shape | Meaning |
| --- | --- | --- |
| `readable` | `{ "type": "readable", "size": 32 }` | Read exactly this many bytes. A partial read fails. |
| `bytes` | `{ "type": "bytes", "pattern": "48 89 ?? 24" }` | Compare the bytes at the final address with a bounded wildcard pattern. |
| `range` | `{ "type": "range", "dataType": "u32", "min": "0", "max": "10000" }` | Decode a little-endian value and check inclusive bounds. |
| `in_module` | `{ "type": "in_module", "module": "MyApp.exe" }` | Require the final address to belong to the named loaded module. |
| `alignment` | `{ "type": "alignment", "value": 8 }` | Require an address divisible by this power-of-two alignment. |

Numeric types: `u8`, `i8`, `u16`, `i16`, `u32`, `i32`, `u64`, `i64`, `f32`, `f64`. Integers use exact arithmetic; float checks reject non-finite values. A valid zero is distinct from a failed read.

## Limits

| Input | Limit |
| --- | --- |
| Catalog entries | 250 |
| Pattern length | 256 bytes |
| Pointer chain | 1–12 hops |
| Explicit checks per entry | 16 |
| One readable check | 1–65,536 bytes |
| Unsigned address / RVA | `0` through `2^64 − 1` |
| Signed offset / addend | `−2^63` through `2^63 − 1` |
| Relative instruction size | 1–64 bytes |
| Relative displacement offset | 0–60; four-byte displacement must fit within the instruction |
| Alignment | Power of two from 1 through 65,536 |
| Notes | 4,000 characters |

Catalog parsing rejects malformed fields, invalid filenames, duplicate entries, unsafe JavaScript numeric addresses, and unknown check types. Imported data is never executed as code.

## Baselines and exports

A baseline must belong to the same catalog and the same mode (`demo` or `live`). An item whose resolver definition changed is not treated as a comparable moved offset. Names and notes are display metadata; the complete catalog fingerprint still invalidates export approval after edits.

Reviewed manifests are **output artifacts**, distinct from editable catalog documents. Import the catalog JSON to edit recipes. Keep the run report to retain diagnostic evidence. The first version does not import arbitrary full-workspace bundles.

SHA-256 fingerprints detect definition changes; they are not signatures authenticating a file's author.
