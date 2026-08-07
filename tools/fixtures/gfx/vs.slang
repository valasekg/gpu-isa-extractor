// The producer half of the pair. Emits every varying the fragment shader reads, from
// SV_VertexID alone, so the pipeline needs no vertex input state and nothing is foldable:
// every interpolant traces back to a runtime value.

struct VOut
{
    float4 pos    : SV_Position;
    float3 normal : NORMAL;
    float2 uv     : TEXCOORD0;
    float4 tint   : COLOR0;
};

[shader("vertex")]
VOut vsMain(uint vid : SV_VertexID)
{
    float2 p = float2(float((vid << 1) & 2), float(vid & 2));

    VOut o;
    o.pos    = float4(p * 2.0f - 1.0f, 0.0f, 1.0f);
    o.normal = float3(p.x, p.y, 1.0f);
    o.uv     = p;
    o.tint   = float4(p.x, p.y, 1.0f - p.x, 1.0f);
    return o;
}
