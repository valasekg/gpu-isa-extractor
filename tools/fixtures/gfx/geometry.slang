// The geometry-stage fixture.
//
// A geometry shader cannot be the only stage in its pipeline - it has nothing to read without
// something in front of it - so this file carries the vertex shader that feeds it. That also
// makes it the fixture for "a file holding two stages uses its own vertex shader as the
// producer" on the geometry road, the same way `shader.slang` does on the fragment one.
//
// The input is declared `triangle`, which is what the reflector reads back as the topology the
// input assembler has to be set to. Reading it wrongly is not a subtle failure: a
// triangle-input geometry shader behind a point list is a pipeline the driver rejects outright.

struct V2G
{
    float4 pos    : SV_Position;
    float3 colour : COLOR0;
};

struct G2F
{
    float4 pos    : SV_Position;
    float3 colour : COLOR0;
    float2 uv     : TEXCOORD0;
};

[shader("vertex")]
V2G vsMain(uint vid : SV_VertexID)
{
    float2 q = float2(float((vid << 1) & 2), float(vid & 2));

    V2G o;
    o.pos    = float4(q * 2.0f - 1.0f, 0.0f, 1.0f);
    o.colour = float3(q, 1.0f);
    return o;
}

// Enough work per vertex that the listing has something in it: a centroid across the whole
// primitive, which is the thing a geometry shader can do and a vertex shader cannot.
[shader("geometry")]
[maxvertexcount(3)]
void gsMain(triangle V2G input[3], inout TriangleStream<G2F> stream)
{
    float3 centre = (input[0].colour + input[1].colour + input[2].colour) / 3.0f;

    for (int i = 0; i < 3; i++)
    {
        G2F o;
        o.pos    = input[i].pos;
        o.colour = normalize(lerp(input[i].colour, centre, 0.5f));
        o.uv     = input[i].pos.xy * 0.5f + 0.5f;
        stream.Append(o);
    }
}
