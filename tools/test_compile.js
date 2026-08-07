'use strict';

/**
 * The compile path: the flag directive, stage gating, cubin reading and source correlation.
 *
 * All four are pure functions over text or bytes, so this suite needs no compiler and no GPU.
 * The cubin fixtures are *built* here - an ELF64 assembled field by field - so a failure
 * points at the reader rather than at a captured file nobody can re-derive. The end-to-end
 * check against real tools lives in `test_endtoend.js`; this is the part that has to keep
 * working on a machine with neither.
 *
 *   ELECTRON_RUN_AS_NODE=1 Code.exe tools/test_compile.js
 */

const path = require('path');
const compile = require(path.join(__dirname, '..', 'src', 'compile.js'));
const correlate = require(path.join(__dirname, '..', 'src', 'correlate.js'));
const cubin = require(path.join(__dirname, '..', 'src', 'cubin.js'));
const stats = require(path.join(__dirname, '..', 'src', 'stats.js'));

let checks = 0;
let failures = 0;

function check(condition, what, detail = '') {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}`);
  if (detail) console.log(`        ${detail}`);
}

function equal(actual, expected, what) {
  check(actual === expected, what, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n${title}`);
}

// --------------------------------------------------------------------------- directive

section('1. The compile-flags directive');

{
  const d = compile.readDirective('// nv-isa-extractor -O3 -use_fast_math\nfloat x;');
  check(!!d, 'a leading // directive is found');
  equal(d.flags.join(' '), '-O3 -use_fast_math', 'its flags are tokenised');
  equal(d.line, 0, 'its line is reported');

  const hash = compile.readDirective('#  nv-isa-extractor -O0\n');
  check(hash && hash.flags[0] === '-O0', '# is accepted as a comment leader too');

  const colon = compile.readDirective('// nv-isa-extractor: -O0');
  check(colon && colon.flags[0] === '-O0', 'a colon after the name is optional');

  const later = compile.readDirective('// a comment\n\n// nv-isa-extractor -G\nvoid f();');
  check(later && later.flags[0] === '-G', 'the directive may sit below other leading comments');

  check(compile.readDirective('void f();\n') === null, 'a file without one gets null');

  const deep = 'x\n'.repeat(20) + '// nv-isa-extractor -O3';
  check(compile.readDirective(deep) === null,
    'a directive far down the file is not treated as one');

  // CRLF is the Windows default and git checks this repo out that way. `DIRECTIVE_RE` ends
  // in `(.*)$`, and JavaScript's `.` does not match `\r`, so the trailing carriage return
  // used to make the whole match fail and every flag in the file was silently dropped.
  const crlf = compile.readDirective('// nv-isa-extractor -O3 -Xptxas -v\r\nvoid f();\r\n');
  check(!!crlf, 'a CRLF file still yields its directive');
  equal(crlf && crlf.flags.join(' '), '-O3 -Xptxas -v',
    'with every flag, and no stray carriage return in the last one');
  const crlfRouted = compile.effectiveFlags(crlf, '');
  equal(crlfRouted.ptxas.join(' '), '-v', 'and the flags still route to the right tool');
}

{
  // Quoting is what makes an include path with a space survive.
  const d = compile.readDirective('// nv-isa-extractor -I"C:\\Program Files\\inc" -DA=1');
  equal(d.flags.length, 2, 'a quoted path stays one argument');
  equal(d.flags[0], '-IC:\\Program Files\\inc', 'the quotes are consumed, the space kept');
}

section('2. Routing flags to the tool each belongs to');

{
  const r = compile.routeFlags(
    ['-O3', '-Xptxas', '-maxrregcount=32', '-Xnvrtc', '-use_fast_math', '-fp-mode', 'fast']);
  equal(r.primary.join(' '), '-O3 -fp-mode fast', 'bare flags go to the language\'s compiler');
  equal(r.ptxas.join(' '), '-maxrregcount=32', '-Xptxas reaches the assembler');
  equal(r.nvrtc.join(' '), '-use_fast_math', '-Xnvrtc reaches the CUDA front end');

  const eq = compile.routeFlags(['-Xptxas=-v', '-Xnvrtc=-lineinfo']);
  equal(eq.ptxas.join(' '), '-v', 'the -Xptxas=flag spelling works');
  equal(eq.nvrtc.join(' '), '-lineinfo', 'the -Xnvrtc=flag spelling works');

  // The file wins over the setting, so a shader can pin what it needs.
  const merged = compile.effectiveFlags({ flags: ['-O0'] }, '-O3 -Xptxas -v');
  equal(merged.primary.join(' '), '-O3 -O0', 'the setting comes first and the file last');
  equal(merged.ptxas.join(' '), '-v', 'settings can carry -X flags too');

  const trailing = compile.routeFlags(['-Xptxas']);
  equal(trailing.ptxas.length, 0, 'a dangling -Xptxas consumes nothing and does not throw');
}

// --------------------------------------------------------------------------- pipeline

section('3. Pipeline controls for a graphics shader');

{
  const HOME = path.resolve('/work/shaders');
  const r = compile.routeFlags(['-O3', '-Xvk', 'samples=4', '-Xvk', 'bind=0:0:8:1',
    '-Xvk', 'bind=0:1:2:1', '-Xvk=format=r16g16b16a16_sf']);
  equal(r.primary.join(' '), '-O3', 'bare flags are untouched by the vk route');
  equal(r.vk.length, 4, '-Xvk collects, in both spellings');

  const p = compile.pipelineControls(r.vk, HOME);
  equal(p.errors.length, 0, 'well-formed controls raise nothing', p.errors.join('; '));
  equal(p.state.samples, 4, 'a sample count is read as a number');
  equal(p.state.format, 'r16g16b16a16_sf', 'a render-target format is read');
  equal(JSON.stringify(p.layout.bindings), '[[0,0,8,1],[0,1,2,1]]',
    'bindings become set:binding:type:count, count defaulting to 1');
}

{
  // The distinction that matters: saying nothing is NOT the same as saying "no descriptors".
  // An empty layout where one should have been reflected drops every binding the shader
  // declares, and the measured effect of a wrong layout is different code, not an error.
  const quiet = compile.pipelineControls([], path.resolve('/w'));
  check(quiet.layout === null, 'a file that says nothing gets no layout, not an empty one');
  const stated = compile.pipelineControls(['push=128'], path.resolve('/w'));
  check(stated.layout !== null && stated.layout.pushBytes === 128,
    'but a stated push-constant range does make the layout explicit');
}

{
  const HOME = path.resolve('/work/shaders');
  const p = compile.pipelineControls(['producer=../common/fullscreen.slang:vsMain'], HOME);
  equal(p.producer.file, path.resolve(HOME, '../common/fullscreen.slang'),
    'a producer path resolves against the shader, like an include directory does');
  equal(p.producer.entry, 'vsMain', 'and its entry point is split off');

  const bare = compile.pipelineControls(['producer=fullscreen.slang'], HOME);
  equal(bare.producer.entry, null, 'naming no entry point is allowed');
  // A drive letter carries a colon of its own, which a naive split would read as an entry.
  const drive = compile.pipelineControls(['producer=C:\\shaders\\full.slang'], HOME);
  equal(drive.producer.entry, null, 'a Windows drive letter is not mistaken for an entry point');
  equal(drive.producer.file, path.resolve('C:\\shaders\\full.slang'), 'and the path survives');
}

{
  const bad = compile.pipelineControls(
    ['bind=0:0', 'samples=3', 'nonsense=1', 'format'], path.resolve('/w'));
  equal(bad.errors.length, 4, 'every malformed control is reported, not the first only',
    JSON.stringify(bad.errors));
  check(/power of two/.test(bad.errors[1]), 'a sample count that is not a power of two is named');
  check(/not a pipeline control/.test(bad.errors[2]), 'an unknown control is named');
  check(bad.layout === null, 'and nothing malformed leaks into the layout');
}

// --------------------------------------------------------------------------- includes

section('4. Include directories');

// Built with `path.resolve` rather than written out, so the expectations are the platform's
// own spelling and the suite says the same thing on both.
const HOME = path.resolve('/work/shaders');
const COMMON = path.resolve('/work/common');

/** The directories a flag list ends up searching, per tool. */
function dirsOf(args) {
  return args.filter(a => a.startsWith('-I')).map(a => a.slice(2));
}

{
  // Nothing asked for, and the file's own directory is still on the path. This is the case
  // that matters most: it is what an unsaved buffer needs, because the copy it is compiled
  // from lives in the scratch directory and every sibling of the real file is invisible there.
  const bare = compile.toolFlags({ primary: [], nvrtc: [], ptxas: [] },
    { home: HOME, language: 'slang' });
  equal(dirsOf(bare.slang).join(' '), HOME, 'slangc searches the file\'s own directory');
  equal(dirsOf(bare.cuda).join(' '), HOME, 'and so does the CUDA front end');

  const cu = compile.toolFlags({ primary: [], nvrtc: [], ptxas: [] },
    { home: HOME, language: 'cuda' });
  equal(dirsOf(cu.cuda).join(' '), HOME,
    'a .cu file gets it too - NVRTC has no notion of a source directory of its own');
}

{
  // The point of resolving against the file: an extension host's working directory is
  // wherever the editor was started, so a relative -I means nothing without a base.
  const routed = compile.routeFlags(['-I../common', '-O3']);
  const f = compile.toolFlags(routed, { home: HOME, language: 'slang' });
  equal(dirsOf(f.slang).join(' '), `${HOME} ${COMMON}`,
    'a relative directory resolves against the source file, and the file\'s own leads');
  equal(f.slang[0], '-O3', 'the flags that are not include paths keep their order');
}

{
  // Every spelling in, one spelling out. slangc refuses -include-path, so the long forms
  // cannot simply be passed through.
  for (const spelling of [['-I', COMMON], [`-I${COMMON}`], [`--include-path=${COMMON}`],
    ['--include-path', COMMON], [`-include-path=${COMMON}`]]) {
    const f = compile.toolFlags(compile.routeFlags(spelling), { home: HOME, language: 'slang' });
    equal(dirsOf(f.slang).join(' '), `${HOME} ${COMMON}`,
      `${spelling.join(' ')} names a directory`);
    check(f.slang.every(a => a.startsWith('-I') || !/include-path/.test(a)),
      'and is re-emitted as -I, which is the only form slangc takes', f.slang.join(' '));
  }
}

{
  const f = compile.toolFlags(compile.routeFlags(['-I.', `-I${HOME}`, '-Ifoo/..']),
    { home: HOME, language: 'slang' });
  equal(dirsOf(f.slang).join(' '), HOME,
    'three spellings of the directory that is already there collapse to one');
}

{
  const dangling = compile.toolFlags(compile.routeFlags(['-O3', '-I']),
    { home: HOME, language: 'slang' });
  equal(dirsOf(dangling.slang).join(' '), HOME,
    'a dangling -I names nothing rather than swallowing the next flag');
  equal(dangling.slang[0], '-O3', 'and does not throw');
}

{
  // Include paths follow the same rule as every other flag: they go to the compiler for the
  // language the file is written in, and -X reaches past it.
  const slang = compile.toolFlags(compile.routeFlags([`-I${COMMON}`, '-Xnvrtc', '-Icuda-inc']),
    { home: HOME, language: 'slang' });
  equal(dirsOf(slang.slang).join(' '), `${HOME} ${COMMON}`,
    'a bare -I in a .slang file reaches slangc');
  equal(dirsOf(slang.cuda).join(' '), `${HOME} ${path.resolve(HOME, 'cuda-inc')}`,
    'and -Xnvrtc -I reaches the CUDA stage instead - the two paths stay separate');

  const cuda = compile.toolFlags(compile.routeFlags([`-I${COMMON}`, '-Xnvrtc', '-Icuda-inc']),
    { home: HOME, language: 'cuda' });
  equal(dirsOf(cuda.cuda).join(' '), `${HOME} ${COMMON} ${path.resolve(HOME, 'cuda-inc')}`,
    'in a .cu file both lists reach the same tool, so both directories do');
  equal(dirsOf(cuda.cuda).length, new Set(dirsOf(cuda.cuda)).size,
    'and merging the two lists does not emit the file\'s own directory twice');
}

{
  // The whole path from a line of text to an argument list, which is what the feature is.
  const directive = compile.readDirective(
    '// nv-isa-extractor -I"../my shaders/inc" -Xptxas -v\nimport helpers;');
  const f = compile.toolFlags(compile.effectiveFlags(directive, ''),
    { home: HOME, language: 'slang' });
  equal(dirsOf(f.slang)[1], path.resolve(HOME, '../my shaders/inc'),
    'a quoted directory with a space survives the directive as one argument');
  equal(f.ptxas.join(' '), '-v', 'and the flags for the other stages are untouched');
  equal(f.dirs.join(' '), dirsOf(f.slang).join(' '),
    'the reported directories are the ones actually searched');
}

// --------------------------------------------------------------------------- stages

section('5. Entry points and the stage gate');

{
  const src = `
    [shader("compute")]
    [numthreads(64,1,1)]
    void csMain(uint3 t : SV_DispatchThreadID) { }
  `;
  const found = compile.slangEntryPoints(src);
  equal(found.length, 1, 'a compute entry point is found');
  equal(found[0].name, 'csMain',
    'the function is named, not the [numthreads(...)] attribute between it and [shader]');
  equal(found[0].stage, 'compute', 'its stage is read');

  const typed = compile.slangEntryPoints('[shader("compute")] float4 f(int x) { }');
  equal(typed[0].name, 'f', 'a non-void return type does not become the name');
}

{
  // A fragment shader is no longer refused - it takes the other road. The decision still has
  // to happen before slangc, for the original reason: asked to lower a graphics stage to
  // CUDA, slangc crashes rather than declining.
  const frag = '[shader("fragment")]\nfloat4 psMain(float2 uv : UV) : SV_Target { }';
  const routed = compile.chooseSlangEntry(frag);
  equal(routed.lineage, 'graphics', 'a fragment-only file routes to the driver, not to CUDA');
  equal(routed.entry, 'psMain', 'naming the entry point, because a pipeline needs one');
  equal(routed.stage, 'fragment', 'and carrying its stage');
  check(routed.producer === null,
    'with no producer in the file, so one will have to be generated');

  const vert = compile.chooseSlangEntry(
    'struct O { float4 p : SV_Position; };\n[shader("vertex")] O vsMain(uint i : SV_VertexID) { }');
  equal(vert.lineage, 'graphics', 'a vertex shader routes the same way');

  // Geometry is a pipeline stage like the other two, and it needs a producer like fragment
  // does - it has nothing to read without a stage in front of it.
  const geom = compile.chooseSlangEntry(
    '[shader("geometry")][maxvertexcount(3)] void gsMain(triangle float4 i[3]) { }');
  equal(geom.lineage, 'graphics', 'a geometry shader routes to the driver too');
  equal(geom.stage, 'geometry', 'carrying its stage');

  // Tessellation is the first pair where BOTH halves are mandatory: Vulkan rejects a pipeline
  // holding one without the other, so each names the other as its counterpart.
  const pair = '[shader("hull")] void hsMain() { }\n[shader("domain")] void dsMain() { }';
  const tess = compile.chooseSlangEntry(pair);
  equal(tess.stage, 'domain', 'a hull/domain file compiles the domain half by default');
  check(tess.counterpart && tess.counterpart.name === 'hsMain',
    'and names the hull half as its counterpart', JSON.stringify(tess.counterpart));
  const asHull = compile.chooseSlangEntry(pair, 'hsMain');
  check(asHull.counterpart && asHull.counterpart.name === 'dsMain',
    'and the reverse holds when the hull is named', JSON.stringify(asHull.counterpart));

  const compute = compile.chooseSlangEntry('[shader("compute")] void only() { }');
  equal(compute.lineage, 'cuda', 'compute still goes through CUDA');
  equal(compute.entry, undefined,
    'and a compute-only file still lets slangc discover entry points itself');
}

{
  // The stages with no road at all. Their refusal is the one that has to keep working.
  // Geometry, hull and domain are deliberately NOT in this list any more - they have
  // pipelines now, and a test that still demanded a refusal would be asserting the feature
  // does not exist.
  for (const stage of ['raygeneration', 'mesh', 'amplification']) {
    const src = `[shader("${stage}")] void f() { }`;
    let threw = null;
    try { compile.chooseSlangEntry(src); } catch (e) { threw = e; }
    check(threw instanceof compile.CompileError, `a ${stage}-only file is still refused`);
    check(threw && /cache file/i.test(threw.message),
      `and ${stage} is pointed at the cache route instead`, threw && threw.message);
  }
  let threw = null;
  try { compile.chooseSlangEntry('[shader("mesh")] void m() { }', 'm'); } catch (e) { threw = e; }
  check(threw instanceof compile.CompileError,
    'naming an unroutable entry point explicitly is refused too');
}

{
  const mixed = `
    [shader("fragment")] float4 ps(float2 uv : UV) : SV_Target { }
    [shader("compute")] [numthreads(32,1,1)] void cs(uint3 t : SV_DispatchThreadID) { }
  `;
  // Compute still wins by default, so a file that used to compile still compiles the same
  // thing. The two roads cannot be walked at once, so one has to be named.
  const chosen = compile.chooseSlangEntry(mixed);
  equal(chosen.entry, 'cs', 'a mixed compute/graphics file still takes its compute entry');
  equal(chosen.lineage, 'cuda', 'down the CUDA road');
  check(/ps \(fragment\)/.test(chosen.note || ''), 'and says what it did not compile',
    chosen.note);

  const asked = compile.chooseSlangEntry(mixed, 'ps');
  equal(asked.lineage, 'graphics',
    'naming the graphics entry point explicitly now compiles it rather than refusing');
}

{
  // The pairing that matters most: a file holding both halves of a real pipeline. Using its
  // own vertex shader as the producer means the fragment shader is compiled against the
  // varyings the author actually wrote, not against invented ones.
  const pair = `
    struct V2F { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
    [shader("vertex")] V2F vsMain(uint i : SV_VertexID) { }
    [shader("fragment")] float4 fsMain(V2F i) : SV_Target { }
  `;
  const chosen = compile.chooseSlangEntry(pair, 'fsMain');
  equal(chosen.lineage, 'graphics', 'the fragment entry routes to the driver');
  check(chosen.producer && chosen.producer.name === 'vsMain',
    'and the file\'s own vertex shader is picked up as its producer',
    JSON.stringify(chosen.producer));

  const asVertex = compile.chooseSlangEntry(pair, 'vsMain');
  check(asVertex.producer === null,
    'a vertex entry needs no consumer - rasterizer discard yields identical code');
}

section('6. Languages');

{
  equal(compile.languageOf('a.slang'), 'slang', '.slang');
  equal(compile.languageOf('a.CU'), 'cuda', '.cu, case-insensitively');
  equal(compile.languageOf('a.ptx'), 'ptx', '.ptx');
  equal(compile.languageOf('a.cubin'), 'cubin', '.cubin');
  equal(compile.languageOf('a.bin'), null, 'a cache blob is not a source file');
}

section('7. What ptxas -v reports');

{
  const log = [
    "ptxas info    : Compiling entry function 'other' for 'sm_86'",
    'ptxas info    : Function properties for other',
    '    16 bytes stack frame, 0 bytes spill stores, 0 bytes spill loads',
    'ptxas info    : Used 40 registers, 0 bytes smem',
    "ptxas info    : Compiling entry function 'csMain' for 'sm_86'",
    'ptxas info    : Function properties for csMain',
    '    0 bytes stack frame, 8 bytes spill stores, 4 bytes spill loads',
    'ptxas info    : Used 18 registers, used 1 barriers, 256 bytes smem, 352 bytes cmem[0]'
  ].join('\n');

  const info = compile.parsePtxasInfo(log, 'csMain');
  equal(info.registers, 18, 'the named entry point\'s register count is taken');
  equal(info.sharedBytes, 256, 'its shared memory is taken');
  equal(info.localBytes, 0, 'its stack frame is taken');
  equal(info.spillStores, 8, 'its spill stores are taken');
  check(compile.parsePtxasInfo(log, 'other').registers === 40,
    'and the other entry point in the same log is not confused with it');
}

// --------------------------------------------------------------------------- cubin

section('8. Reading a cubin');

/** Build an ELF64 cubin with one .text section, field by field. */
function buildCubin({ machine = 190, sm = 86, entry = 'k', code = null, regs = 12 } = {}) {
  const body = code || Buffer.alloc(32);                       // two instructions
  const names = ['', '.shstrtab', '.symtab', '.strtab', `.text.${entry}`];
  const shstr = Buffer.from(names.join('\0') + '\0', 'latin1');
  const offsets = {};
  let at = 0;
  for (const n of names) { offsets[n] = at; at += n.length + 1; }

  const strtab = Buffer.from(`\0${entry}\0`, 'latin1');
  const sym = Buffer.alloc(24 * 2);                            // null symbol + the function
  sym.writeUInt32LE(1, 24);                                    // st_name -> "k"
  sym[24 + 4] = 2;                                             // STT_FUNC

  const EH = 64;
  const SH = 64;
  const shnum = 5;
  const dataStart = EH;
  const parts = [
    { name: '.shstrtab', buf: shstr, type: 3 },
    { name: '.symtab', buf: sym, type: 2, link: 3, entsize: 24 },
    { name: '.strtab', buf: strtab, type: 3 },
    { name: `.text.${entry}`, buf: body, type: 1, info: (regs << 24) >>> 0 }
  ];
  let cursor = dataStart;
  for (const p of parts) { p.offset = cursor; cursor += p.buf.length; }
  const shoff = cursor;

  const out = Buffer.alloc(shoff + shnum * SH);
  out.writeUInt32LE(0x464c457f, 0);
  out[4] = 2; out[5] = 1; out[6] = 1;
  out.writeUInt16LE(2, 0x10);                                  // ET_EXEC
  out.writeUInt16LE(machine, 0x12);
  out.writeUInt32LE((sm << 8) | 4, 0x30);                      // e_flags: sm in bits [8,16)
  out.writeBigUInt64LE(BigInt(shoff), 0x28);
  out.writeUInt16LE(SH, 0x3a);
  out.writeUInt16LE(shnum, 0x3c);
  out.writeUInt16LE(1, 0x3e);                                  // shstrndx
  for (const p of parts) p.buf.copy(out, p.offset);

  parts.forEach((p, i) => {
    const base = shoff + (i + 1) * SH;
    out.writeUInt32LE(offsets[p.name], base);
    out.writeUInt32LE(p.type, base + 4);
    out.writeBigUInt64LE(BigInt(p.offset), base + 0x18);
    out.writeBigUInt64LE(BigInt(p.buf.length), base + 0x20);
    out.writeUInt32LE(p.link || 0, base + 0x28);
    out.writeUInt32LE(p.info || 0, base + 0x2c);
    out.writeBigUInt64LE(BigInt(p.entsize || 0), base + 0x38);
  });
  return out;
}

{
  const buf = buildCubin();
  check(cubin.isElf(buf), 'a built cubin is recognised as ELF');
  equal(cubin.arch(buf), 'SM86',
    'the architecture is read from bits [8,16) of e_flags, not the low byte');

  const entries = cubin.entryPoints(buf);
  equal(entries.length, 1, 'its entry point is found');
  equal(entries[0].name, 'k', 'named after .text.<entry>');
  equal(entries[0].codeBytes, 32, 'with the section\'s bytes');
  equal(entries[0].instructions, 2, 'counted as 16-byte instructions');
  equal(entries[0].registers, 12, 'and the register count out of sh_info');

  // The whole point of this module: what comes out is what the cache path produces.
  check(Buffer.isBuffer(entries[0].microcode), 'the microcode is a Buffer');
  check(entries[0].microcode.length % 16 === 0, 'a whole number of instructions');
}

{
  let threw = null;
  try { cubin.entryPoints(Buffer.alloc(64)); } catch (e) { threw = e; }
  check(threw instanceof cubin.CubinError, 'a buffer that is not ELF is refused');

  threw = null;
  try { cubin.entryPoints(buildCubin({ machine: 62 })); } catch (e) { threw = e; }
  check(threw instanceof cubin.CubinError && /EM_CUDA/.test(threw.message),
    'an x86 ELF is refused by name rather than mis-read');

  threw = null;
  try { cubin.entryPoints(buildCubin({ code: Buffer.alloc(24) })); } catch (e) { threw = e; }
  check(threw instanceof cubin.CubinError && /whole number/.test(threw.message),
    'a .text that is not a whole number of instructions is refused, never truncated');
}

// --------------------------------------------------------------------------- correlation

section('9. Source correlation');

const NVDISASM_G = [
  '//--------------------- .text.csMain              --------------------------',
  '\t.section\t.text.csMain,"ax",@progbits',
  'csMain:',
  '\t//## File "C:\\\\work\\\\s.slang", line 9',
  '        /*0000*/                   MOV R1, c[0x0][0x28] ;',
  '\t//## File "C:\\\\work\\\\s.slang", line 11',
  '        /*0010*/                   S2R R0, SR_CTAID.X ;',
  '        /*0020*/                   S2R R3, SR_TID.X ;',
  '\t//## File "C:\\\\work\\\\s.cu", line 1204',
  '        /*0030*/                   MOV R7, 0x4 ;',
  '\t//## File "C:\\\\work\\\\s.slang", line 12',
  '        /*0040*/                   LDG.E R4, [R4.64] ;'
].join('\n');

{
  const parsed = correlate.parse(NVDISASM_G, 'csMain');
  const records = parsed.entries.get('csMain');
  check(!!records, 'the entry point\'s records are found');
  equal(records.length, 4, 'one record per change of position, not one per instruction');
  equal(records[0].line, 9, 'the first line is read');
  equal(records[1].address, 0x10, 'and the address it starts at');
  equal(parsed.files.length, 2, 'both files are collected');
  check(parsed.files[0].includes('s.slang'), 'the C-escaped path is unescaped',
    parsed.files[0]);

  const map = correlate.byAddress(records, 0x50);
  equal(map.size, 5, 'the runs expand to one entry per instruction');
  equal(map.get(0x20).line, 11, 'an address inside a run belongs to the run\'s line');
  equal(map.get(0x30).line, 1204, 'and a new marker starts a new run');
}

{
  // Two files with the same basename must not silently appear as one.
  const labels = correlate.labelsFor(['C:\\a\\k.slang', 'C:\\b\\k.slang']);
  const values = [...labels.values()];
  check(values[0] !== values[1], 'colliding basenames are disambiguated', values.join(' '));

  const plain = correlate.labelsFor(['C:\\a\\k.slang', 'C:\\a\\k.cu']);
  check([...plain.values()].every(v => !v.includes('#')),
    'distinct basenames stay plain');
}

{
  const listing = [
    '        /*0000*/ [B------:R-:W-:Y:S02]  MOV R1, c[0x0][0x28] ;',
    '        /*0010*/ [B------:R-:W0:Y:S01]  S2R R0, SR_CTAID.X ;',
    '        /*0020*/ [B------:R-:W0:Y:S02]  S2R R3, SR_TID.X ;'
  ].join('\n');
  const records = correlate.parse(NVDISASM_G, 'csMain').entries.get('csMain');
  const merged = correlate.annotate(listing, correlate.byAddress(records, 0x30));

  equal(merged.marked, 2, 'a marker is emitted only where the position changes');
  check(merged.text.includes('//## s.slang:9'), 'markers use the short label', merged.text);
  const lines = merged.text.split('\n');
  equal(lines[0].trim(), '//## s.slang:9', 'the marker precedes the run it introduces');
  check(lines[1].includes('/*0000*/'), 'and the instruction follows it');
  equal(merged.unattributed, 0, 'every instruction here has a position');

  const read = correlate.readMarkers(merged.text);
  equal(read.byListingLine.get(1).line, 9, 'the markers read back out of the listing text');
  equal(read.byListingLine.get(3).line, 11, 'for every instruction under a marker');
  equal((read.bySourceLine.get('s.slang:11') || []).length, 2,
    'and one source line maps to every listing row showing it');
}

{
  // A listing with no map is returned untouched rather than half-annotated.
  const listing = '        /*0000*/  MOV R1, c[0x0][0x28] ;';
  const merged = correlate.annotate(listing, new Map());
  equal(merged.text, listing, 'no map means no change');
}

section('10. The banner address map');

{
  const records = [
    { address: 0x00, file: 'C:\\w\\s.slang', line: 9 },
    { address: 0x20, file: 'C:\\w\\s.cu', line: 1204 },
    { address: 0x40, file: 'C:\\w\\s.slang', line: 11 }
  ];
  const labels = correlate.labelsFor(['C:\\w\\s.slang', 'C:\\w\\s.cu']);
  const emitted = correlate.bannerLines(records, labels);
  equal(emitted.join(' | '), '@0000 s.slang:9 | @0020 s.cu:1204 | @0040 s.slang:11',
    'runs are emitted as address = label:line');

  // A listing carrying the map in its banner and NOTHING between the instructions.
  const listing = [
    '//============================================================================',
    '// csMain - compute shader',
    ...emitted.map(e => `//                 ${e}`),
    '//                 s.slang = C:\\w\\s.slang',
    '',
    '        /*0000*/ [B------:R-:W-:Y:S02]  MOV R1, c[0x0][0x28] ;',
    '        /*0010*/ [B------:R-:W0:Y:S01]  S2R R0, SR_CTAID.X ;',
    '        /*0020*/ [B------:R-:W-:Y:S01]  MOV R7, 0x4 ;',
    '        /*0030*/ [B------:R-:W-:-:S04]  ULDC.64 UR4, c[0x0][0x118] ;',
    '        /*0040*/ [B------:R-:W-:-:S02]  IMAD R2, R2, R3, R11 ;'
  ].join('\n');

  check(!listing.includes('//##'), 'the instruction stream carries no inline markers');

  const map = correlate.readAddressMap(listing);
  equal(map.length, 3, 'the banner map is read back');
  equal(map[1].label, 's.cu', 'with its labels');

  // The point of keying on address: an instruction inside a run resolves to the run's line.
  equal(correlate.positionAt(map, 0x10).line, 9,
    'an address inside a run takes the run\'s source line');
  equal(correlate.positionAt(map, 0x30).line, 1204, 'and a later run takes its own');
  equal(correlate.positionAt(map, 0x40).line, 11, 'exactly on a boundary starts the new run');
  check(correlate.positionAt(map, -1) === null, 'an address before the first run has no position');

  const { byListingLine, bySourceLine } = correlate.readMarkers(listing);
  equal(byListingLine.size, 5,
    'every instruction resolves, not only those that follow a marker');
  // The banner is rows 0-5 and row 6 is blank, so the instructions start at row 7.
  equal((bySourceLine.get('s.slang:9') || []).join(','), '7,8',
    'a source line gathers every listing row in its run');
  equal((bySourceLine.get('s.cu:1204') || []).join(','), '9,10',
    'including the inlined file');

  // Keyed on address, so the map survives the banner it lives in changing length.
  const taller = listing.replace('// csMain - compute shader',
    '// csMain - compute shader\n// registers     : 18 allocated by ptxas\n// extra line');
  const shifted = correlate.readMarkers(taller);
  equal((shifted.bySourceLine.get('s.slang:9') || []).join(','), '9,10',
    'two more banner lines move the rows by two, and the mapping still lands');
}

{
  // Listings written before the banner map exist on disk and must keep working.
  const legacy = [
    '// a banner with no address map',
    '',
    '        //## s.slang:9',
    '        /*0000*/  MOV R1, c[0x0][0x28] ;',
    '        //## s.slang:11',
    '        /*0010*/  S2R R0, SR_CTAID.X ;'
  ].join('\n');
  const { byListingLine, bySourceLine } = correlate.readMarkers(legacy);
  equal(byListingLine.size, 2, 'an inline-marker listing still resolves');
  equal((bySourceLine.get('s.slang:11') || []).join(','), '5', 'to the right rows');
}

{
  // The map has no line cap. A cap does not fail loudly: positionAt would keep returning the
  // last run it managed to read, so every instruction past the cut would be attributed to the
  // wrong source line while still looking correct.
  const many = [];
  for (let i = 0; i < 6000; i++) many.push(`//                 @${(i * 16).toString(16)} big.cu:${i + 1}`);
  const huge = ['//====', ...many, '', '        /*1770*/  EXIT ;'].join('\n');
  const map = correlate.readAddressMap(huge);
  equal(map.length, 6000, 'a banner with 6000 runs is read whole, not truncated');
  equal(correlate.positionAt(map, 0x5DC0).line, 1501,
    'and a run far past any plausible cap still resolves to its own line');
}

{
  // Compiling an unsaved buffer compiles a copy, so the line table names the copy. The copy
  // is an implementation detail; left unrewritten the banner claims one file while the map
  // names another and correlation matches nothing.
  const parsed = {
    entries: new Map([['csMain', [
      { address: 0, file: 'C:\\scratch\\compile\\ab\\k.slang', line: 9 },
      { address: 16, file: 'C:\\scratch\\compile\\ab\\k.cu', line: 1204 }
    ]]]),
    files: ['C:\\scratch\\compile\\ab\\k.slang', 'C:\\scratch\\compile\\ab\\k.cu']
  };
  const fixed = correlate.rewriteSource(
    parsed, 'C:\\scratch\\compile\\ab\\k.slang', 'D:\\work\\k.slang');

  equal(fixed.entries.get('csMain')[0].file, 'D:\\work\\k.slang',
    'the compiled-from path is rewritten to the file the user has open');
  equal(fixed.entries.get('csMain')[1].file, 'C:\\scratch\\compile\\ab\\k.cu',
    'and the generated intermediate is left alone - it really is that file');
  equal(fixed.files[0], 'D:\\work\\k.slang', 'the file table is rewritten too');

  const same = correlate.rewriteSource(parsed, 'D:\\work\\k.slang', 'D:\\work\\k.slang');
  check(same === parsed, 'a saved buffer, where the paths already agree, is untouched');
  check(correlate.rewriteSource(parsed, null, 'D:\\work\\k.slang') === parsed,
    'and so is the case where there was no copy at all');
}

section('11. Correlating a selection, not just a cursor');

{
  const listing = [
    '        //## s.slang:11',                                   // 0
    '        /*0000*/  MOV R1, c[0x0][0x28] ;',                  // 1
    '        /*0010*/  S2R R0, SR_CTAID.X ;',                    // 2
    '        //## s.cu:1204',                                    // 3
    '        /*0020*/  MOV R7, 0x4 ;',                           // 4
    '        //## s.slang:12',                                   // 5
    '        /*0030*/  LDG.E R4, [R4.64] ;',                     // 6
    '        //## s.slang:11',                                   // 7
    '        /*0040*/  IMAD R2, R2, R3, R11 ;',                  // 8
    '        //## s.slang:20',                                   // 9
    '        /*0050*/  EXIT ;'                                   // 10
  ].join('\n');
  const { byListingLine, bySourceLine } = correlate.readMarkers(listing);

  // One line, scattered: the scheduler interleaved line 11's work around line 12's.
  equal(correlate.rowsFor(bySourceLine, 's.slang', [11]).join(','), '1,2,8',
    'a single source line still gathers every row attributed to it');

  // The point of the feature: a selection spanning several source lines.
  equal(correlate.rowsFor(bySourceLine, 's.slang', [11, 12]).join(','), '1,2,6,8',
    'a multi-line selection gathers the union, in listing order');
  equal(correlate.rowsFor(bySourceLine, 's.slang', [11, 11, 12]).join(','), '1,2,6,8',
    'and repeats do not duplicate rows');

  equal(correlate.rowsFor(bySourceLine, 's.slang', [13, 14]).length, 0,
    'source lines that produced no code select nothing');
  equal(correlate.rowsFor(bySourceLine, 's.cu', [1204]).join(','), '4',
    'the inlined file is addressed by its own label');
  equal(correlate.rowsFor(bySourceLine, null, [11]).length, 0,
    'a listing that does not name this file at all yields nothing');

  // The inverse: selecting a run of instructions asks where all of it came from.
  const back = correlate.sourcesFor(byListingLine, [1, 2, 4, 6]);
  equal(back.get('s.slang').join(','), '11,12', 'a listing selection reports every source line');
  equal(back.get('s.cu').join(','), '1204', 'grouped per file, so inlined code stays visible');
  equal(correlate.sourcesFor(byListingLine, [0, 3, 5]).size, 0,
    'selecting only marker lines reports nothing - they carry no instruction');
}

{
  // Runs are what keep a large selection cheap: adjacent rows collapse into one range.
  equal(JSON.stringify(correlate.runs([3, 1, 2, 7, 8, 12])), '[[1,3],[7,8],[12,12]]',
    'consecutive lines merge, gaps split, and the input need not be sorted');
  equal(JSON.stringify(correlate.runs([5, 5, 5])), '[[5,5]]', 'duplicates collapse');
  equal(JSON.stringify(correlate.runs([])), '[]', 'nothing selected is no ranges');

  // The pathological case is contiguous, which is exactly why runs make it safe: selecting a
  // whole source file matches most of a listing and still yields a handful of ranges.
  const everything = Array.from({ length: 500000 }, (_, i) => i);
  equal(correlate.runs(everything).length, 1,
    'selecting a whole file collapses to one range, not half a million');
}

section('12. Markers must not reach the statistics');

{
  // `stats.analyze` scans the whole listing string for register operands rather than each
  // instruction line, so a path component that looks like a register would be counted as one.
  // The banner is therefore built from the pre-merge text; this is the check that says why.
  const listing = [
    '        /*0000*/ [B------:R-:W-:Y:S02]  MOV R1, c[0x0][0x28] ;',
    '        /*0010*/ [B------:R-:W-:Y:S02]  FADD R2, R1, R1 ;'
  ].join('\n');
  const microcode = Buffer.alloc(32);

  const clean = stats.analyze(listing, microcode);
  const poisoned = stats.analyze(
    ['        //## R8G8B8A8_resolve.slang:11', listing].join('\n'), microcode);

  check(poisoned.registers.maxVector !== clean.registers.maxVector,
    'a marker naming a path like R8G8B8A8 does change what the statistics see',
    `clean ${clean.registers.maxVector}, with marker ${poisoned.registers.maxVector}`);
  equal(clean.registers.maxVector, 2,
    'so the banner must analyse the listing before markers are merged into it');
}

console.log(`\n${failures ? 'FAIL' : 'PASS'}  ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
