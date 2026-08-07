// nv-isa-extractor -O3
//
// A geometry shader that expands one point into a camera-facing quad, as an input for
// **NVIDIA ISA: Compile and Disassemble** (Ctrl+Alt+Shift+B).
//
// This is the billboard-particle technique: the vertex shader emits one vertex per particle,
// and the geometry stage turns each one into four, oriented against the camera and rotated by
// the particle's own angle. It is on this road for the same reason `surface-shading.slang` is
// - a geometry stage has no CUDA lowering, so the extension asks the display driver to build a
// pipeline and reads the SASS back out of its shader cache.
//
// ## What makes a geometry listing different
//
// `gsMain` compiles to 152 instructions in 29 registers here. Two opcode families appear that
// no other stage produces:
//
//   OUT.EMIT x4              one per emitted vertex - the instruction that actually pushes a
//   OUT.FINAL                vertex downstream, and the one that closes the strip. This is
//                            amplification made visible: one vertex in, four out
//   ISBERD                   input stream buffer element read - how a geometry shader reaches
//                            the vertices of its input primitive at all
//   ALD.96 x2                attribute loads pulling the producer's output in...
//   AST.128 x4 / AST.64 x4   ...and attribute stores pushing this stage's output out, four
//   AST x4                   times over, one group per emitted vertex, sized per varying
//                            (128 bits for the float4 position, 64 for the float2 uv, 32 for
//                            the float fade)
//
//   MUFU.SIN / MUFU.COS      the per-particle rotation, on the special-function unit
//   BMOV.64 x2, LEPC         the emit loop's convergence bookkeeping
//
// Compare that with `surface-shading.slang`, whose fragment listing is all `IPA` reads and no
// stores: the two stages sit on opposite ends of the same attribute traffic.
//
// The vertex half is 40 instructions - press the key on a copy with `gsMain` commented out to
// see it, since a consuming stage wins when both are present.
//
// ## The topology is read out of the shader, not chosen
//
// This shader declares `point V2G input[1]`, so the pipeline that compiles it has to be fed a
// point list. The banner says so:
//
//     pipeline      : geometry stage, 1 binding(s) by reflection, producer vsMain from this
//                     file, point_list in, into r8g8b8a8_unorm
//
// That is not a detail the extension gets to pick. A triangle-input geometry shader behind a
// point list is an invalid pipeline - and this driver builds it anyway, exits zero, and
// returns the same microcode, so nothing downstream could tell. The topology is therefore read
// from the module's declared input primitive, and a mismatch is refused before the driver sees
// it. `-Xvk topology=point_list` states it explicitly; it is still checked against what the
// shader declares, so it documents rather than overrides.
//
// ## The producer
//
// A geometry shader has nothing to read without a stage in front of it, so it needs a producer
// exactly as a fragment shader does. The vertex shader in this file is used, which is what the
// `producer vsMain from this file` line records. Measured on the test fixture: a *generated*
// producer yields byte-identical geometry microcode, so this stage does not depend on which
// producer it gets - only on having one. Naming the real one still means the listing describes
// the pipeline you wrote.

struct Camera
{
    float4x4 viewProj;
    float4   right;          // camera basis, xyz
    float4   up;
};

ConstantBuffer<Camera> gCamera;

struct V2G
{
    float4 centre : SV_Position;
    float4 params : TEXCOORD0;   // x size, y rotation, z fade
};

struct G2F
{
    float4 pos  : SV_Position;
    float2 uv   : TEXCOORD0;
    float  fade : TEXCOORD1;
};

// One vertex per particle, derived from the vertex index so the pipeline needs no vertex
// buffer and nothing here can be folded into a constant.
[shader("vertex")]
V2G vsMain(uint vid : SV_VertexID)
{
    float t = float(vid) * 0.37f;

    V2G o;
    o.centre = float4(sin(t), cos(t * 1.3f), t * 0.01f, 1.0f);
    o.params = float4(0.02f + 0.01f * sin(t), t, 1.0f - t * 0.01f, 0.0f);
    return o;
}

// One point in, four vertices out. The quad is built in the camera's basis rather than in
// world space, which is what makes it face the viewer however the camera moves.
[shader("geometry")]
[maxvertexcount(4)]
void gsMain(point V2G input[1], inout TriangleStream<G2F> stream)
{
    float size  = input[0].params.x;
    float angle = input[0].params.y;
    float fade  = input[0].params.z;

    float s = sin(angle);
    float c = cos(angle);

    float3 right = (gCamera.right.xyz * c + gCamera.up.xyz * s) * size;
    float3 up    = (gCamera.up.xyz * c - gCamera.right.xyz * s) * size;

    // Strip order, so four vertices make two triangles with no index buffer.
    const float2 corners[4] = { float2(-1, -1), float2(1, -1), float2(-1, 1), float2(1, 1) };

    for (int i = 0; i < 4; i++)
    {
        float3 world = input[0].centre.xyz + right * corners[i].x + up * corners[i].y;

        G2F o;
        o.pos  = mul(gCamera.viewProj, float4(world, 1.0f));
        o.uv   = corners[i] * 0.5f + 0.5f;
        o.fade = fade;
        stream.Append(o);          // each of these is an OUT.EMIT in the listing
    }
}
