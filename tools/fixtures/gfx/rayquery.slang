RaytracingAccelerationStructure gScene;
cbuffer Light { float4 dir; }

struct V2F { float4 pos : SV_Position; float3 world : TEXCOORD0; float3 normal : NORMAL; };

[shader("vertex")]
V2F vsMain(uint vid : SV_VertexID)
{
    float2 q = float2(float((vid << 1) & 2), float(vid & 2));
    V2F o;
    o.pos    = float4(q * 2.0f - 1.0f, 0.0f, 1.0f);
    o.world  = float3(q * 8.0f - 4.0f, 0.0f);
    o.normal = float3(0, 0, 1);
    return o;
}

[shader("fragment")]
float4 fsMain(V2F i) : SV_Target
{
    RayDesc ray;
    ray.Origin    = i.world + i.normal * 1e-3f;
    ray.Direction = normalize(-dir.xyz);
    ray.TMin      = 1e-3f;
    ray.TMax      = 1000.0f;

    RayQuery<RAY_FLAG_ACCEPT_FIRST_HIT_AND_END_SEARCH> q;
    q.TraceRayInline(gScene, RAY_FLAG_NONE, 0xff, ray);
    q.Proceed();

    float shadow = (q.CommittedStatus() == COMMITTED_TRIANGLE_HIT) ? 0.25f : 1.0f;
    float ndl    = saturate(dot(i.normal, normalize(-dir.xyz)));
    return float4(ndl.xxx * shadow, 1.0f);
}
