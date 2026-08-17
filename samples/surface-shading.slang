// gpu-isa-extractor -O3
//
// A vertex shader and the fragment shader it feeds, as an input for
// **NVIDIA ISA: Compile and Disassemble** (Ctrl+Alt+Shift+B).
//
// This file takes a different road from `prefix-blur.slang`. A graphics stage has no CUDA
// lowering at all - `slangc -stage fragment -target cuda` crashes rather than declining - so
// there is no `.cu`, no PTX and no cubin anywhere in this path. Instead the shader goes to
// SPIR-V, the extension asks the **display driver** to build one pipeline out of it, and the
// SASS is read back out of the driver's own shader cache. Nothing is drawn: no swapchain, no
// images, no render pass, no draw call.
//
// That is the same compiler that runs when this shader is part of a real frame, so what you
// are looking at is the code the GPU actually executes when drawing - not a CUDA translation
// of it.
//
// ## Two entry points, one pipeline
//
// Press Ctrl+Alt+Shift+B and you get `fsMain`, because a fragment shader is the more
// interesting listing. `vsMain` is not ignored: a fragment shader cannot be compiled alone -
// a Vulkan pipeline has no such thing as a fragment-only pipeline - so something has to feed
// it, and the vertex shader in this file is used. The banner says so:
//
//     pipeline      : fragment stage, 3 binding(s) by reflection, producer vsMain from this
//                     file, into r8g8b8a8_unorm
//
// That matters more than it looks. The driver eliminates any vertex output nothing downstream
// reads, so the producer decides how much of the vertex shader survives - measured here, a
// consumer reading two fewer varyings deleted the `AST.96`/`AST.64` attribute stores and took
// the vertex shader from 48 instructions to 40. Using the pairing you actually wrote means the
// listing describes your pipeline rather than an invented one.
//
// To read the vertex half instead, comment out `fsMain` - a fragment entry point wins when
// both are present, and there is no picker for this yet. `vsMain` is then compiled with
// rasterizer discard and no fragment stage at all, which sounds like it should strip it down
// and does not: it produces byte-identical code to the paired build, 64 instructions either
// way. The driver only narrows a stage's outputs when the *next* stage's inputs are narrower,
// and with no next stage there is nothing to narrow against.
//
// ## What to look for in the generated listing
//
// `fsMain` compiles to 80 instructions in 14 registers here, and holds:
//
//   IPA.PASS x6              interpolants read out of attribute space, one per slot. This is
//                            the single most characteristic thing about fragment SASS and has
//                            no equivalent in a compute listing - the banner counts them as
//                            `attributes : 6 slot(s), a[0x7c]-a[0x94]`
//   MUFU.RCP x4              the perspective divide, before the interpolants are usable
//   TEX.SCR.NODEP            the texture fetch, arming a scoreboard in the W field
//   MUFU.LG2 x3 / EX2 x3     `pow` on the special-function unit, as a log-multiply-exp pair
//   MUFU.RSQ x2              the two `normalize` calls
//   KILL                     the alpha test below. The banner reads `discards : yes (per the
//                            shader header)` - a bit the container records, meaningful for a
//                            fragment shader and meaningless for a kernel
//
// The vertex half is 64 instructions, and the interesting opcodes there are the other side of
// the same coin: `AST.128`, `AST.96` and `AST.64` are the attribute *stores* that feed the
// `IPA` reads above - one per varying, sized by its width.
//
// ## What this road does not give you
//
// **No source correlation.** There are no `//##` markers and no address map in the banner,
// and that is not a gap waiting to be filled: the driver keeps no line table. SPIR-V built
// with `slangc -g` - `OpLine`, `OpSource`, the whole source text embedded - produces a cache
// object that is byte-identical and exactly the same size as one built without it. The driver
// strips all of it. Correlation is a property of the compute road, where the cubin carries a
// line table nvdisasm can read.
//
// **It needs the GPU.** The compute road cross-compiles: `ptxas` will target SM90 from a
// laptop with no NVIDIA card in it. This road asks the local driver to compile, so it needs an
// NVIDIA GPU present and a working Vulkan driver, and it answers for *that* device. The
// architecture in the banner is probed from the hardware and deliberately ignores the
// `gpuIsaExtractor.arch` setting, which exists for reading a cache written by a GPU that is not
// here.
//
// ## Telling it about your pipeline
//
// Two things a shader file cannot state, and both were measured to change the generated code
// without changing anything visible in it: the descriptor layout, and the producer. They are
// reflected out of the SPIR-V by default and printed in the banner. Where you know better -
// because you know how your engine binds this shader - say so on the directive line:
//
//     // gpu-isa-extractor -Xvk bind=0:0:8:1 -Xvk bind=0:1:2:1 -Xvk bind=0:2:0:1
//
// That declares binding 0 a *dynamic* uniform buffer, which is how many engines bind their
// per-draw constants, and restates the other two so the layout is complete - any `bind` at all
// replaces the reflected layout rather than adding to it.
//
// On this shader the instruction count does not move: 80 either way. The *code* does - one
// fewer `ULDC.64`, because a dynamic buffer takes its offset at bind time and the constant
// load moves. That is the point worth taking away: a wrong layout does not announce itself by
// making the listing longer. On a shader with more uniform traffic the same substitution was
// measured to change 48 instructions into 40, and merely adding four bindings the shader never
// touches changed the code at an identical instruction count. If your engine binds this shader
// differently from the reflected default, the listing is for a pipeline you do not run.

struct Surface
{
    float4x4 mvp;
    float4   tint;
    float4   light;          // xyz direction, w exposure
};

ConstantBuffer<Surface> gSurface;
Texture2D<float4>       gAlbedo;
SamplerState            gSampler;

struct V2F
{
    float4 pos    : SV_Position;
    float3 normal : NORMAL;
    float2 uv     : TEXCOORD0;
};

// A full-screen triangle from the vertex index alone, so the pipeline needs no vertex buffer
// and every varying is still a runtime value the compiler cannot fold away.
[shader("vertex")]
V2F vsMain(uint vid : SV_VertexID)
{
    float2 q = float2(float((vid << 1) & 2), float(vid & 2));
    float3 p = float3(q * 2.0f - 1.0f, 0.0f);

    V2F o;
    o.pos    = mul(gSurface.mvp, float4(p, 1.0f));
    o.uv     = q;
    o.normal = normalize(float3(q.x - 0.5f, q.y - 0.5f, 1.0f));
    return o;
}

[shader("fragment")]
float4 fsMain(V2F i) : SV_Target
{
    float4 albedo = gAlbedo.Sample(gSampler, i.uv) * gSurface.tint;

    // An alpha test. This is what sets the `discards` bit in the shader header, and it is why
    // the driver cannot hoist the depth test ahead of the shader for this pipeline.
    if (albedo.a < 0.05f) discard;

    float3 n   = normalize(i.normal);
    float  ndl = saturate(dot(n, normalize(gSurface.light.xyz)));

    float3 lit = albedo.rgb * ndl * gSurface.light.w;
    lit = lit / (lit + 1.0f);                    // tonemap
    lit = pow(lit, 1.0f / 2.2f);                 // gamma, on the special-function unit

    return float4(lit, albedo.a);
}
