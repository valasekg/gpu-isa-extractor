// gpu-isa-extractor -O3
//
// A tessellated terrain patch - hull shader, domain shader and the vertex shader that feeds
// them - as an input for **NVIDIA ISA: Compile and Disassemble** (Ctrl+Alt+Shift+B).
//
// The hull shader decides how finely each patch is subdivided, from its distance to the
// origin; the domain shader evaluates the subdivided points and displaces them by a height
// map. That split is the whole reason tessellation has two stages: one runs per patch and
// decides *how much*, the other runs per generated vertex and decides *where*.
//
// ## Neither stage exists on its own
//
// Vulkan rejects a pipeline holding a hull shader with no domain shader, and the reverse. So
// compiling either one means building all three stages, and the banner records which halves
// were real:
//
//     pipeline      : domain stage, 3 binding(s) by reflection, producer vsMain from this
//                     file, patch_list in of 4, into r8g8b8a8_unorm
//
// Pressing the key compiles `dsMain`, because a domain shader is the more interesting listing
// and this file supplies its own hull. To read the hull half instead, delete `dsMain` - or
// keep both and note what the banner then says, because the two directions are not
// symmetrical.
//
// ## The asymmetry, measured
//
// | what is compiled | counterpart | result |
// |---|---|---|
// | `dsMain` | this file's `hsMain` | 96 instructions, 23 registers |
// | `dsMain` | a **generated** hull | 96 instructions - **byte-identical** |
// | `hsMain` | this file's `dsMain` | 136 instructions, 28 registers |
// | `hsMain` | a **generated** domain | 136 instructions, **different bytes** |
//
// A domain shader does not depend on which hull feeds it, so generating one costs nothing. A
// hull shader does depend on its domain shader, twice over: the generated one reads every
// output the hull declares where the real one may read fewer, so the driver eliminates less;
// and it brings no descriptors of its own, so the reflected layout shrinks from three
// bindings to one - and a different layout was measured to change the generated code. The
// extension says so in a note rather than presenting the result as your pipeline.
//
// ## What to look for
//
//   ISBERD                   reading the input patch, as in a geometry shader
//   ALD / AST                per-control-point attribute traffic, the patch coming in and
//                            going back out
//   the tessellation factors the hull shader's real output. `SV_TessFactor` and
//                            `SV_InsideTessFactor` are what the fixed-function tessellator
//                            consumes; everything else in `hsConst` exists to compute them
//   TEX / MUFU               in the domain half, the height-map fetch and the interpolation
//
// ## A slangc bug worth knowing about
//
// This file uses a `quad` domain, which takes two inside tessellation factors and therefore
// declares them as an array. The commoner `tri` domain takes one, and the idiomatic spelling
// is a bare scalar:
//
//     float inside : SV_InsideTessFactor;          // crashes slangc 2024.13
//     float inside[1] : SV_InsideTessFactor;       // compiles
//
// The scalar form asserts inside the compiler - `toStyle != TypeCastStyle::Unknown` - with no
// diagnostic pointing at the cause. The extension recognises that failure and says which line
// to change, because the shader is correct and the compiler is not.

struct Displace { float4x4 viewProj; float4 params; };
ConstantBuffer<Displace> gDisplace;
Texture2D<float>  gHeight;
SamplerState      gSampler;

struct VSOut  { float3 pos : POSITION; float2 uv : TEXCOORD0; };
struct HSOut  { float3 pos : POSITION; float2 uv : TEXCOORD0; };
struct HSConst{ float edges[4] : SV_TessFactor; float inside[2] : SV_InsideTessFactor; };
struct DSOut  { float4 pos : SV_Position; float2 uv : TEXCOORD0; float height : TEXCOORD1; };

[shader("vertex")]
VSOut vsMain(uint vid : SV_VertexID)
{
    float2 q = float2(float((vid << 1) & 2), float(vid & 2));
    VSOut o; o.pos = float3(q * 16.0f - 8.0f, 0.0f); o.uv = q; return o;
}

HSConst hsConst(InputPatch<VSOut, 4> patch)
{
    HSConst c;
    float3 centre = (patch[0].pos + patch[1].pos + patch[2].pos + patch[3].pos) * 0.25f;
    float  near   = saturate(1.0f - length(centre) * gDisplace.params.x);
    for (int k = 0; k < 4; k++)
    {
        float3 a = patch[k].pos, b = patch[(k + 1) & 3].pos;
        c.edges[k] = lerp(1.0f, gDisplace.params.y, near * saturate(length(a - b) * 0.1f));
    }
    c.inside[0] = lerp(1.0f, gDisplace.params.y, near);
    c.inside[1] = c.inside[0];
    return c;
}

[shader("hull")][domain("quad")][partitioning("fractional_odd")]
[outputtopology("triangle_cw")][outputcontrolpoints(4)][patchconstantfunc("hsConst")]
HSOut hsMain(InputPatch<VSOut, 4> patch, uint i : SV_OutputControlPointID)
{
    HSOut o; o.pos = patch[i].pos; o.uv = patch[i].uv; return o;
}

[shader("domain")][domain("quad")]
DSOut dsMain(HSConst c, float2 d : SV_DomainLocation, const OutputPatch<HSOut, 4> patch)
{
    float3 top = lerp(patch[0].pos, patch[1].pos, d.x);
    float3 bot = lerp(patch[3].pos, patch[2].pos, d.x);
    float3 p   = lerp(top, bot, d.y);
    float2 uv  = lerp(lerp(patch[0].uv, patch[1].uv, d.x), lerp(patch[3].uv, patch[2].uv, d.x), d.y);

    float h = gHeight.SampleLevel(gSampler, uv, 0.0f) * gDisplace.params.z;
    p.z += h;

    DSOut o; o.pos = mul(gDisplace.viewProj, float4(p, 1.0f)); o.uv = uv; o.height = h;
    return o;
}
