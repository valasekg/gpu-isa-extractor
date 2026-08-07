// Generated: the other half of a tessellation pair. Hull and domain shaders cannot
// exist apart, so compiling one means supplying the other.
struct Patch
{
    [[vk::location(0)]] float3 v0 : TEXCOORD0;
};

struct PatchConstants
{
    float edges[4] : SV_TessFactor;
    float inside[2] : SV_InsideTessFactor;
};

PatchConstants hsConst(InputPatch<Patch, 4> patch)
{
    PatchConstants c;
    c.edges[0] = 2.0f;
    c.edges[1] = 2.0f;
    c.edges[2] = 2.0f;
    c.edges[3] = 2.0f;
    c.inside[0] = 2.0f;
    c.inside[1] = 2.0f;
    return c;
}

[shader("hull")]
[domain("quad")]
[partitioning("integer")]
[outputtopology("triangle_cw")]
[outputcontrolpoints(4)]
[patchconstantfunc("hsConst")]
Patch hsMain(InputPatch<Patch, 4> patch, uint i : SV_OutputControlPointID)
{
    return patch[i];
}
