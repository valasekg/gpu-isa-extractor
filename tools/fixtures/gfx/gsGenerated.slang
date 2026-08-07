// Generated: the producer for a fragment shader compiled on its own. Outputs match
// the consumer's inputs by location and type, and every value is derived from
// SV_VertexID so none of it can be folded into the consumer.
struct V2F
{
    float4 pos : SV_Position;
    [[vk::location(0)]] float3 v0 : TEXCOORD0;
};

[shader("vertex")]
V2F vsMain(uint vid : SV_VertexID)
{
    float2 q = float2(float((vid << 1) & 2), float(vid & 2));
    float seed = q.x + q.y;
    V2F o;
    o.pos = float4(q * 2.0f - 1.0f, 0.0f, 1.0f);
    o.v0 = float3(seed + 0.0f, seed + 0.0f, seed + 0.0f);
    return o;
}
