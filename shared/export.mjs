import { validateCatalog, hashCatalog, hashItem, parseAddress, parseOffset } from './catalog.mjs';

const ELIGIBLE = new Set(['valid', 'moved']);

/** Approvals are scoped to a completed run and the exact current catalog. */
function reviewed(catalogInput, run, approvedIds) {
  const catalog = validateCatalog(catalogInput);
  if (!run || run.schemaVersion !== 1 || !['live', 'demo'].includes(run.mode)) {
    throw new Error('Export requires a completed live or demo build check.');
  }
  if (run.catalogId !== catalog.id || run.catalogHash !== hashCatalog(catalog)) {
    throw new Error('The catalog changed after this check. Check this build again before exporting.');
  }
  if (!run.id || !run.completedAt || !Array.isArray(run.results)) {
    throw new Error('The build check is incomplete.');
  }
  if (!(Array.isArray(approvedIds) || approvedIds instanceof Set)) {
    throw new Error('Explicitly review and select the entries to export.');
  }
  const ids = [...approvedIds];
  if (!ids.length) throw new Error('Review at least one valid or moved entry before exporting.');
  if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    throw new Error('The review selection contains invalid or duplicate entry IDs.');
  }
  const resultMap = new Map();
  for (const result of run.results) {
    if (!result || typeof result.id !== 'string' || resultMap.has(result.id)) {
      throw new Error('The build report contains invalid or duplicate results.');
    }
    resultMap.set(result.id, result);
  }
  const selected = ids.map(id => {
    const item = catalog.items.find(entry => entry.id === id);
    const result = resultMap.get(id);
    if (!item || !result || item.enabled === false || !ELIGIBLE.has(result.status)) {
      throw new Error(`Entry ${id} is not a valid, reviewed export candidate.`);
    }
    if (result.definitionHash !== hashItem(item)) {
      throw new Error(`Entry ${item.name} changed after the check. Run a new check.`);
    }
    if (typeof result.address !== 'string' || parseAddress(result.address, 'Resolved address') === 0n) {
      throw new Error(`Entry ${item.name} has no usable resolved address.`);
    }
    if (!Array.isArray(result.checks) || !result.checks.length || result.checks.some(check => !check || check.passed !== true)) {
      throw new Error(`Entry ${item.name} has a failed validation.`);
    }
    return { item, result };
  });
  return { catalog, selected };
}

/** Export recipes and evidence. Observed absolute addresses are never runtime constants. */
export function createManifest(catalogInput, run, approvedIds) {
  const { catalog, selected } = reviewed(catalogInput, run, approvedIds);
  return {
    schemaVersion: 1,
    format: 'signature-doctor/reviewed-manifest',
    mode: run.mode,
    demo: run.mode === 'demo',
    notice: run.mode === 'demo'
      ? 'DEMO DATA — synthetic observations. Do not use these recipes against a real target.'
      : 'Resolve these recipes against the current target. Observed addresses are evidence, not persistent offsets.',
    project: { id: catalog.id, name: catalog.name, processName: catalog.processName },
    source: {
      runId: run.id,
      label: run.label,
      completedAt: run.completedAt,
      catalogHash: run.catalogHash,
      baselineId: run.baselineId ?? null,
    },
    entries: selected.map(({ item, result }) => ({
      id: item.id,
      name: item.name,
      definitionHash: result.definitionHash,
      resolver: Object.fromEntries(
        ['kind', 'module', 'pattern', 'rva', 'relative', 'addend', 'offsets', 'pointerSize']
          .filter(key => item[key] !== undefined)
          .map(key => [key, structuredClone(item[key])]),
      ),
      checks: structuredClone(item.checks),
      notes: item.notes ?? '',
      observed: {
        status: result.status,
        address: result.address,
        module: result.module ?? null,
        rva: result.rva ?? null,
        sourceModule: result.sourceModule ?? null,
        sourceRva: result.sourceRva ?? null,
        checks: structuredClone(result.checks),
      },
    })),
  };
}

const quote = value => JSON.stringify(String(value));
const comment = value => String(value).replace(/[\r\n\u2028\u2029]/g, ' ').replace(/\*\//g, '* /');
const u64 = value => `uint64(0x${BigInt(value).toString(16)})`;

function identifiers(selected) {
  const seen = new Set(['sd_add', 'sd_readable', 'sd_resolve_all']);
  return selected.map(({ item }) => {
    const base = `sd_${item.id.replace(/[^A-Za-z0-9_]/g, '_')}`;
    let name = base;
    let suffix = 2;
    while (seen.has(name) || seen.has(`${name}_resolve`)) name = `${base}_${suffix++}`;
    seen.add(name);
    seen.add(`${name}_resolve`);
    return name;
  });
}

function adjustment(source, target, offset, prefix = '    ') {
  const value = parseOffset(offset, 'Offset');
  return `${prefix}if (!sd_add(${source}, ${u64(value < 0n ? -value : value)}, ${value < 0n ? 'true' : 'false'}, ${target})) return false;`;
}

function integerLiteral(value, signed) {
  const n = BigInt(value);
  if (!signed) return u64(n);
  if (n === -(1n << 63n)) return '(-int64(0x7fffffffffffffff) - 1)';
  return n < 0n ? `-int64(0x${(-n).toString(16)})` : `int64(0x${n.toString(16)})`;
}

function floatLiteral(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Floating-point checks require finite bounds.');
  const text = number.toString();
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

const READ_TYPES = {
  u8: ['uint8', 'read_uint8', false], i8: ['int8', 'read_int8', true],
  u16: ['uint16', 'read_uint16', false], i16: ['int16', 'read_int16', true],
  u32: ['uint32', 'read_uint32', false], i32: ['int32', 'read_int32', true],
  u64: ['uint64', 'read_uint64', false], i64: ['int64', 'read_int64', true],
  f32: ['float', 'read_float', null], f64: ['double', 'read_double', null],
};

function generateChecks(item) {
  const lines = [];
  item.checks.forEach((check, index) => {
    lines.push(`    // Validation ${index + 1}: ${check.type}`);
    if (check.type === 'readable') {
      lines.push(`    if (!sd_readable(candidate, ${check.size})) return false;`);
    } else if (check.type === 'bytes') {
      const tokens = check.pattern.split(' ');
      lines.push(`    if (candidate > uint64(0xffffffffffffffff) - ${tokens.length - 1}) return false;`);
      lines.push(`    array<uint8>@ bytes_${index} = process::read_bytes(candidate, ${tokens.length});`);
      lines.push(`    if (bytes_${index} is null || bytes_${index}.length() != ${tokens.length}) return false;`);
      tokens.forEach((token, offset) => {
        if (token !== '??') lines.push(`    if (bytes_${index}[${offset}] != 0x${token}) return false;`);
      });
    } else if (check.type === 'in_module') {
      lines.push(`    uint64 check_base_${index} = process::get_module_base(${quote(check.module)});`);
      lines.push(`    uint64 check_size_${index} = process::get_module_size(check_base_${index});`);
      lines.push(`    if (check_base_${index} == 0 || candidate < check_base_${index} || candidate - check_base_${index} >= check_size_${index}) return false;`);
    } else if (check.type === 'alignment') {
      lines.push(`    if (candidate % ${check.value} != 0) return false;`);
    } else if (check.type === 'range') {
      const spec = READ_TYPES[check.dataType];
      if (!spec) throw new Error(`Cannot export range type ${check.dataType}.`);
      const [type, read, signed] = spec;
      const width = Number(check.dataType.slice(1)) / 8;
      const min = signed === null ? floatLiteral(check.min) : integerLiteral(check.min, signed);
      const max = signed === null ? floatLiteral(check.max) : integerLiteral(check.max, signed);
      lines.push(`    ${type} value_${index} = 0;`);
      lines.push(`    if (candidate > uint64(0xffffffffffffffff) - ${width - 1}) return false;`);
      lines.push(`    if (!process::${read}(candidate, value_${index})) return false;`);
      if (signed === null) lines.push(`    if (value_${index} != value_${index}) return false; // NaN`);
      const expression = signed === null ? `double(value_${index})` : `value_${index}`;
      lines.push(`    if (!(${expression} >= ${min} && ${expression} <= ${max})) return false;`);
    } else {
      throw new Error(`Cannot export unsupported validation ${check.type}.`);
    }
  });
  return lines;
}

function generateResolver(item, name) {
  const lines = [
    `// ${comment(item.name)} — ${comment(item.module)} / ${item.kind}`,
    `bool ${name}_resolve(uint64 &out address)`,
    '{',
    '    address = 0;',
    `    uint64 module_base = process::get_module_base(${quote(item.module)});`,
    '    if (module_base == 0) return false;',
    '    uint64 module_size = process::get_module_size(module_base);',
    '    if (module_size == 0 || module_base > uint64(0xffffffffffffffff) - (module_size - 1)) return false;',
    '    uint64 candidate = 0;',
  ];
  if (item.kind === 'signature') {
    const patternSize = item.pattern.split(' ').length;
    lines.push(
      `    array<uint64>@ hits = process::find_signatures(module_base, ${quote(item.pattern)});`,
      '    if (hits is null || hits.length() != 1) return false; // Never pick an ambiguous hit.',
      '    candidate = hits[0];',
      '    if (candidate < module_base || candidate - module_base >= module_size) return false;',
      `    if (${patternSize} > module_size - (candidate - module_base)) return false;`,
    );
    if (item.relative) {
      const { offset, instructionSize } = item.relative;
      lines.push(
        '    uint64 displacement_address = 0;',
        `    if (!sd_add(candidate, ${u64(offset)}, false, displacement_address)) return false;`,
        '    int32 displacement = 0;',
        '    if (displacement_address > uint64(0xffffffffffffffff) - 3) return false;',
        '    if (!process::read_int32(displacement_address, displacement)) return false;',
        '    uint64 next_instruction = 0;',
        `    if (!sd_add(candidate, ${u64(instructionSize)}, false, next_instruction)) return false;`,
        '    uint64 expected = 0;',
        '    uint64 magnitude = displacement < 0 ? uint64(-int64(displacement)) : uint64(displacement);',
        '    if (!sd_add(next_instruction, magnitude, displacement < 0, expected)) return false;',
        `    uint64 relative_target = process::get_relative_address(candidate, ${offset}, ${instructionSize});`,
        '    if (relative_target == 0 || relative_target != expected) return false;',
        '    candidate = relative_target;',
      );
    }
  } else {
    const rva = parseAddress(item.rva, 'RVA');
    lines.push(
      `    if (${u64(rva)} >= module_size) return false;`,
      `    if (!sd_add(module_base, ${u64(rva)}, false, candidate)) return false;`,
    );
    if (item.kind === 'pointer') {
      item.offsets.forEach((offset, index) => {
        const type = item.pointerSize === 4 ? 'uint32' : 'uint64';
        lines.push(
          `    ${type} pointer_${index} = 0;`,
          `    if (candidate > uint64(0xffffffffffffffff) - ${item.pointerSize - 1}) return false;`,
          `    if (!process::read_${type}(candidate, pointer_${index}) || pointer_${index} == 0) return false;`,
          adjustment(`uint64(pointer_${index})`, 'candidate', offset),
        );
      });
    }
  }
  lines.push(adjustment('candidate', 'candidate', item.addend ?? '0x0'));
  lines.push('    if (candidate == 0) return false;');
  if (!item.checks.some(check => check.type === 'readable')) {
    lines.push('    if (!sd_readable(candidate, 1)) return false; // Same implicit probe as the dashboard.');
  }
  lines.push(...generateChecks(item));
  lines.push('    address = candidate;', '    return true;', '}', '');
  return lines.join('\n');
}

/** Generate a standalone read-only resolver. Demo observations cannot produce production .as. */
export function generateAngelScript(catalogInput, run, approvedIds) {
  const { catalog, selected } = reviewed(catalogInput, run, approvedIds);
  if (run.mode !== 'live') {
    throw new Error('AngelScript export requires a live check. Demo manifests are available as JSON.');
  }
  const names = identifiers(selected);
  const modules = [...new Set(selected.flatMap(({ item }) => [
    item.module, ...item.checks.filter(check => check.type === 'in_module').map(check => check.module),
  ]))];
  const lines = [
    '// Signature Doctor — portable AngelScript runtime resolvers',
    `// Project: ${comment(catalog.name)}`,
    `// Build: ${comment(run.label)} | Run: ${comment(run.id)}`,
    `// Completed: ${comment(run.completedAt)}`,
    '// Uses the shared documented AngelScript Process API.',
    '// Re-resolves recipes and repeats every validation. Never writes target memory.',
    '// Verify target-specific behavior in your installed AngelScript host runtime.',
    '// This is a standalone script. When integrating, retain the helpers and merge main().',
    '// Call sd_resolve_all() again after an attachment or target build changes.',
    '',
    `const string SD_PROCESS = ${quote(catalog.processName)};`,
    ...names.map(name => `uint64 ${name} = 0;`),
    '',
    'bool sd_add(uint64 value, uint64 amount, bool subtract, uint64 &out result)',
    '{',
    '    result = 0;',
    '    if (subtract)',
    '    {',
    '        if (value < amount) return false;',
    '        result = value - amount;',
    '    }',
    '    else',
    '    {',
    '        if (value > uint64(0xffffffffffffffff) - amount) return false;',
    '        result = value + amount;',
    '    }',
    '    return result != 0;',
    '}',
    '',
    'bool sd_readable(uint64 address, uint size)',
    '{',
    '    if (address == 0 || size == 0 || address > uint64(0xffffffffffffffff) - (size - 1)) return false;',
    '    array<uint8>@ bytes = process::read_bytes(address, size);',
    '    return bytes !is null && bytes.length() == size;',
    '}',
    '',
    ...selected.map(({ item }, index) => generateResolver(item, names[index])),
    'bool sd_resolve_all()',
    '{',
    ...names.map(name => `    ${name} = 0;`),
    '    if (!process::is_alive()) return false;',
    ...modules.flatMap((module, index) => [
      `    uint64 before_base_${index} = process::get_module_base(${quote(module)});`,
      `    uint64 before_size_${index} = process::get_module_size(before_base_${index});`,
      `    if (before_base_${index} == 0 || before_size_${index} == 0) return false;`,
    ]),
    ...names.flatMap(name => [
      `    uint64 candidate_${name} = 0;`,
      `    if (!${name}_resolve(candidate_${name})) { print(${quote(`Signature Doctor: ${name} failed resolution or validation.`)}); return false; }`,
    ]),
    '    if (!process::is_alive()) return false;',
    ...modules.map((module, index) =>
      `    if (process::get_module_base(${quote(module)}) != before_base_${index} || process::get_module_size(before_base_${index}) != before_size_${index}) return false;`),
    ...names.map(name => `    ${name} = candidate_${name};`),
    '    return true;',
    '}',
    '',
    'bool main()',
    '{',
    '    attach_data target = process::attach(SD_PROCESS);',
    '    if (target.pid == 0) { print("Signature Doctor: target process was not found."); return false; }',
    '    if (!sd_resolve_all()) { print("Signature Doctor: resolution failed; no addresses published."); return false; }',
    `    print(${quote(`Signature Doctor: ${selected.length} reviewed resolver(s) passed.`)});`,
    '    return true;',
    '}',
    '',
  ];
  return lines.join('\n');
}
