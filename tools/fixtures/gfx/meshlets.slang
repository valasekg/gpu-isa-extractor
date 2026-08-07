struct Payload { float3 offset; float scale; };
struct MeshOut { float4 pos : SV_Position; float3 colour : COLOR0; };

groupshared Payload gPayload;

[shader("amplification")]
[numthreads(1, 1, 1)]
void ampMain(uint3 tid : SV_DispatchThreadID)
{
    Payload p;
    p.offset = float3(float(tid.x) * 0.1f, 0.0f, 0.0f);
    p.scale  = 1.0f + float(tid.x) * 0.01f;
    gPayload = p;
    DispatchMesh(1, 1, 1, gPayload);
}

[shader("mesh")]
[numthreads(3, 1, 1)]
[outputtopology("triangle")]
void meshMain(uint3 tid : SV_DispatchThreadID,
              in payload Payload p,
              out vertices MeshOut verts[3],
              out indices uint3 tris[1])
{
    SetMeshOutputCounts(3, 1);
    const float2 corners[3] = { float2(-1, -1), float2(1, -1), float2(0, 1) };
    uint i = tid.x;
    verts[i].pos    = float4(corners[i] * p.scale + p.offset.xy, 0.0f, 1.0f);
    verts[i].colour = float3(corners[i] * 0.5f + 0.5f, 1.0f);
    if (i == 0) tris[0] = uint3(0, 1, 2);
}
