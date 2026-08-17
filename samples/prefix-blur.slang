// gpu-isa-extractor -O3 -fp-mode fast
//
// A Slang compute shader, as an input for **NVIDIA ISA: Compile and Disassemble**
// (Ctrl+Alt+Shift+B).
//
// The first line is a compile-flags directive. For a `.slang` file bare flags go to
// **slangc** - `-O3` and `-fp-mode fast` are slangc's own - while `-Xnvrtc <flag>` reaches
// the CUDA front end and `-Xptxas <flag>` the assembler.
//
// ## Floating-point mode and contraction are different axes
//
// `-fp-mode fast|precise` governs value-changing optimisations - reassociation, denormals,
// infinities, negative zero, and which version of a special function is used. It says nothing
// about **contraction**, the fusing of `a*b + c` into a single FFMA, and it does not control
// it: compiling this shader `-fp-mode precise` instead of `fast` leaves the SASS *byte for
// byte identical*. slangc has no contraction flag either; `-fp-mode` is its only fp switch.
//
// In HLSL and Slang the language-level control over contraction is the per-value `precise`
// qualifier, which forbids fusing and reordering for the values feeding it. It does not work
// through this path: slangc emits the keyword verbatim into the generated CUDA, where it is
// not a keyword, and NVRTC stops with
//
//     error: identifier "precise" is undefined
//         precise float acc_0;
//
// (Slang 2024.13, as shipped in Vulkan SDK 1.3.296.0. Note the error names *this* file's
// line number rather than the generated one - the `#line` directives that carry the source
// correlation carry the diagnostics too.)
//
// So on the CUDA target, contraction is the backend's decision and is reached through the
// backend: `-Xnvrtc --fmad=false` pulls the fused multiply-adds apart, taking this shader
// from 12 FFMA, 5 FMUL and 3 FADD to 5, 12 and 10, and from 104 instructions to 112. Which
// layer owns which decision is exactly the sort of thing a listing is for settling.
//
// ## What you are actually looking at
//
// This is compiled through Slang's **CUDA** target, so the SASS is what the CUDA compiler
// makes of this shader - not what the driver's *graphics* compiler would emit if the same
// code ran in a Vulkan or D3D12 pipeline. Those are different backends. For a graphics
// shader's real SASS, open the driver's shader cache instead; that is what the rest of this
// extension is for.
//
// Only compute entry points can be compiled this way at all. A `[shader("fragment")]`
// function has no CUDA lowering, and the command refuses it before slangc is invoked.
//
// ## Correlation
//
// Markers in the listing name two files. `prefix-blur.slang` is this file. The other is the
// generated CUDA intermediate, and instructions attributed to it come from Slang's inlined
// prelude - the implementations behind `sqrt`, buffer indexing and the like. They are
// labelled rather than folded into the nearest line here, because an instruction attributed
// to a line you did not write is less misleading than one attributed to a line you did.

static const uint GROUP = 64;
static const int RADIUS = 3;

StructuredBuffer<float> source;
RWStructuredBuffer<float> result;

cbuffer Params
{
    uint count;
    float weight;
}

groupshared float tile[GROUP + 2 * RADIUS];

// A weighted blur across a group-shared tile, with the halo loaded by the first threads.
// The halo load is deliberately guarded rather than clamped arithmetically, so the listing
// has a branch to look at as well as a barrier.
[shader("compute")]
[numthreads(GROUP, 1, 1)]
void blurMain(uint3 tid : SV_DispatchThreadID, uint3 gid : SV_GroupThreadID)
{
    const uint local = gid.x + RADIUS;
    const uint global = tid.x;

    tile[local] = global < count ? source[global] : 0.0f;

    // Only the first RADIUS threads of the group fetch the halo. This is the divergence that
    // produces a BSSY/BSYNC pair in the SASS.
    if (gid.x < RADIUS) {
        int left = int(global) - RADIUS;
        int right = int(global) + int(GROUP);
        tile[gid.x] = left >= 0 ? source[left] : 0.0f;
        tile[local + GROUP] = right < int(count) ? source[right] : 0.0f;
    }

    GroupMemoryBarrierWithGroupSync();

    // Unrolled by the compiler into a run of FFMAs, so this one line accounts for a long
    // stretch of the listing.
    float acc = 0.0f;
    [unroll]
    for (int i = -RADIUS; i <= RADIUS; ++i) {
        acc += tile[int(local) + i] * weight;
    }

    // sqrt lowers to MUFU.RSQ - the reciprocal-square-root special-function unit - with a
    // refinement sequence around it, rather than to a call.
    if (global < count) {
        result[global] = sqrt(abs(acc));
    }
}
