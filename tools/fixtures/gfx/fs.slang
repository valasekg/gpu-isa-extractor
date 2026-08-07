// The shader under measurement.
//
// Deliberately declares NO descriptors. The question this sweep asks is whether the colour
// format, the sample count and the depth attachment move the generated SASS; the descriptor
// layout is a separate axis with a known answer (nvsass measured it), and leaving it out
// keeps this measurement from confounding the two.
//
// What it does contain is the shape that would show the effect if there is one: interpolants
// read through IPA, transcendental work that lands on MUFU, and a float4 written to
// SV_Target - which is where any format-dependent pack or convert has to appear.

struct VOut
{
    float4 pos    : SV_Position;
    float3 normal : NORMAL;
    float2 uv     : TEXCOORD0;
    float4 tint   : COLOR0;
};

[shader("fragment")]
float4 psMain(VOut i) : SV_Target
{
    float3 n   = normalize(i.normal);
    float  ndl = saturate(dot(n, float3(0.5773503f, 0.5773503f, 0.5773503f)));

    float3 lit = i.tint.rgb * ndl * (1.0f + i.uv.x);
    lit = lit / (lit + 1.0f);              // tonemap
    lit = pow(lit, 1.0f / 2.2f);           // gamma - MUFU.LG2 / MUFU.EX2

    return float4(lit, i.tint.a * i.uv.y);
}
