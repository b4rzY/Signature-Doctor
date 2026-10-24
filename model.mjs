/**
 * Shared serializable contract. All addresses, offsets and 64-bit values are strings.
 * Runtime arithmetic uses BigInt. Definitions and observed results remain separate.
 * @typedef {{id:string,name:string,module:string,kind:'signature'|'rva'|'pointer',pattern?:string,rva?:string,relative?:{offset:number,instructionSize:number},addend?:string,offsets?:string[],pointerSize?:4|8,checks:Check[],notes?:string,enabled?:boolean}} CatalogItem
 * Pointer resolver: start at module.base + rva, then address = readPointer(address) + offset for each offset.
 * A signature resolver finds ALL hits, requires exactly one, optionally resolves rel32, then applies addend.
 * @typedef {{type:'readable',size:number}|{type:'bytes',pattern:string}|{type:'range',dataType:'u8'|'i8'|'u16'|'i16'|'u32'|'i32'|'u64'|'i64'|'f32'|'f64',min:string,max:string}|{type:'in_module',module:string}|{type:'alignment',value:number}} Check
 * @typedef {{name:string,base:string,size:number}} ModuleInfo
 * @typedef {{schemaVersion:1,id:string,name:string,processName:string,items:CatalogItem[]}} Catalog
 * @typedef {{id:string,status:'valid'|'moved'|'ambiguous'|'missing'|'invalid'|'error'|'disabled',address?:string,module?:string,rva?:string,previousRva?:string,candidates?:string[],message:string,checks:{label:string,passed:boolean,detail:string}[],trace:{label:string,value:string}[],durationMs:number,definitionHash:string}} ItemResult
 * @typedef {{schemaVersion:1,id:string,catalogId:string,catalogHash:string,label:string,mode:'demo'|'live',startedAt:string,completedAt:string,target:{pid:number,base:string,modules:ModuleInfo[]},results:ItemResult[],baselineId?:string}} BuildRun
 * @typedef {(request:Record<string,unknown>,signal?:AbortSignal)=>Promise<Record<string,any>>} Rpc
 */

export const SCHEMA_VERSION = 1;
export const STATUS = Object.freeze({
  valid: { label: 'Valid', tone: 'green' },
  moved: { label: 'Moved', tone: 'amber' },
  ambiguous: { label: 'Ambiguous', tone: 'purple' },
  missing: { label: 'Missing', tone: 'red' },
  invalid: { label: 'Validation failed', tone: 'red' },
  error: { label: 'Read error', tone: 'red' },
  disabled: { label: 'Disabled', tone: 'muted' },
});
