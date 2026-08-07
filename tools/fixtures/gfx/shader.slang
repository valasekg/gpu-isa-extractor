// A shader with enough descriptor traffic that a layout difference has somewhere to show up:
// a uniform buffer read from both stages, a storage buffer, a texture+sampler.
struct Xform { float4x4 mvp; float4 tint; float4 misc[4]; };
ConstantBuffer<Xform>    gXform;     // set 0, binding 0
Texture2D<float4>        gAlbedo;    // set 0, binding 1
SamplerState             gSamp;      // set 0, binding 2
StructuredBuffer<float4> gPoints;    // set 0, binding 3

struct V2F { float4 pos : SV_Position; float2 uv : TEXCOORD0; float4 col : COLOR0; };

// From SV_VertexID alone, so the harness needs no vertex input state.
[shader("vertex")]
V2F vsMain(uint vid : SV_VertexID)
{
    float2 q = float2(float((vid << 1) & 2), float(vid & 2));
    float3 p = float3(q * 2.0f - 1.0f, 0.0f);
    V2F o;
    o.pos = mul(gXform.mvp, float4(p, 1));
    o.uv  = q + gXform.misc[2].xy;
    o.col = gXform.tint * gPoints[3] + gXform.misc[0] + gXform.misc[1] + gXform.misc[3];
    return o;
}

[shader("fragment")]
float4 fsMain(V2F i) : SV_Target
{
    return gAlbedo.Sample(gSamp, i.uv) * i.col * gXform.tint + gXform.misc[1];
}
