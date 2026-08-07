// The tessellation fixture: a vertex shader, a hull shader and the domain shader it feeds.
//
// All three are here because neither tessellation stage exists in a pipeline without the
// other - Vulkan rejects a hull shader with no domain shader, and the reverse - so this is
// also the fixture for "a file holding both halves uses its own".
//
// A `quad` domain deliberately. A `tri` domain is the more common shape, and slangc 2024.13
// asserts on its idiomatic spelling: a scalar `SV_InsideTessFactor` crashes the compiler with
// `assert failure: toStyle != TypeCastStyle::Unknown`, while `float inside[1]` compiles. A
// quad takes two inside factors and so is already an array, which keeps this fixture testing
// the extension rather than a compiler bug. The bug itself has its own diagnostic.
//
// The domain shader reads only `pos`, not `uv`. That asymmetry is the point: it makes the
// hull shader's generated-counterpart case measurably different from its real-counterpart
// case, which is what proves the counterpart is load-bearing.

struct VSOut { float3 pos : POSITION; float2 uv : TEXCOORD0; };
struct HSOut { float3 pos : POSITION; float2 uv : TEXCOORD0; };
struct HSConst { float edges[4] : SV_TessFactor; float inside[2] : SV_InsideTessFactor; };
struct DSOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };

[shader("vertex")]
VSOut vsMain(uint vid : SV_VertexID)
{
    float2 q = float2(float((vid << 1) & 2), float(vid & 2));
    VSOut o;
    o.pos = float3(q * 2.0f - 1.0f, 0.0f);
    o.uv  = q;
    return o;
}

HSConst hsConst(InputPatch<VSOut, 4> patch)
{
    HSConst c;
    float d = length(patch[0].pos - patch[2].pos);
    for (int k = 0; k < 4; k++) c.edges[k] = 1.0f + d * float(k + 1);
    c.inside[0] = 1.0f + d;
    c.inside[1] = 1.0f + d * 0.5f;
    return c;
}

[shader("hull")]
[domain("quad")]
[partitioning("fractional_odd")]
[outputtopology("triangle_cw")]
[outputcontrolpoints(4)]
[patchconstantfunc("hsConst")]
HSOut hsMain(InputPatch<VSOut, 4> patch, uint i : SV_OutputControlPointID)
{
    HSOut o;
    o.pos = patch[i].pos * 1.01f;
    o.uv  = patch[i].uv;
    return o;
}

[shader("domain")]
[domain("quad")]
DSOut dsMain(HSConst c, float2 d : SV_DomainLocation, const OutputPatch<HSOut, 4> patch)
{
    float3 top = lerp(patch[0].pos, patch[1].pos, d.x);
    float3 bot = lerp(patch[3].pos, patch[2].pos, d.x);
    float3 p   = lerp(top, bot, d.y);

    DSOut o;
    o.pos = float4(p, 1.0f);
    o.uv  = d;
    return o;
}
