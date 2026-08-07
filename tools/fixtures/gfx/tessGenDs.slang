// Generated: the other half of a tessellation pair. Hull and domain shaders cannot
// exist apart, so compiling one means supplying the other.
struct Patch
{
    [[vk::location(0)]] float3 v0 : TEXCOORD0;
    [[vk::location(1)]] float2 v1 : TEXCOORD1;
};

struct PatchConstants
{
    float edges[4] : SV_TessFactor;
    float inside[2] : SV_InsideTessFactor;
};

struct DomainOut
{
    float4 pos : SV_Position;
    [[vk::location(0)]] float3 v0 : TEXCOORD0;
    [[vk::location(1)]] float2 v1 : TEXCOORD1;
};

[shader("domain")]
[domain("quad")]
DomainOut dsMain(PatchConstants constants, float2 uv : SV_DomainLocation,
                 const OutputPatch<Patch, 4> patch)
{
    DomainOut o;
    o.pos = float4(uv, 0.0f, 1.0f);
    o.v0 = patch[0].v0;
    o.v1 = patch[0].v1;
    return o;
}
