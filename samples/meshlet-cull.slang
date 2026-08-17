// gpu-isa-extractor -O3
//
// An amplification shader that picks a level of detail per meshlet, and the mesh shader it
// dispatches - as an input for **NVIDIA ISA: Compile and Disassemble** (Ctrl+Alt+Shift+B).
//
// This is the modern geometry pipeline: no vertex shader, no vertex buffer, no input
// assembler. The mesh shader emits vertices and indices directly, and the amplification stage
// in front of it decides how many mesh workgroups to launch at all. The extension builds this
// as a pipeline with no vertex stage - the one graphics pipeline where `pVertexInputState` and
// `pInputAssemblyState` are not merely empty but absent.
//
// ## What to look for
//
// `meshMain` compiles to 56 instructions in 11 registers here, `ampMain` to 48 in 9. The mesh
// half writes its vertices and its index buffer through the same attribute-store machinery a
// geometry shader uses, so the listing has the `AST`/`OUT` shape rather than anything new -
// which is the interesting part: a stage that replaces the whole front of the pipeline still
// compiles down to the hardware the other stages use.
//
// ## The payload is data, and it shows
//
// A mesh shader stands alone; an amplification shader does not, because it exists only to
// dispatch one. But a mesh shader that reads a payload is not the same shader depending on
// whether anything supplies it:
//
//   meshMain paired with ampMain      56 instructions, 11 registers
//   meshMain with no task shader      56 instructions,  9 registers, different bytes
//
// So when this file holds both, both are compiled - and the banner says so. Delete `ampMain`
// and the listing changes, which is the honest reflection of a shader whose input went away
// rather than a bug.
//
// The same measurement in the other direction is why an amplification shader alone is refused
// outright: there is no pipeline for it to be in, and unlike a hull or domain shader, its
// counterpart is not generated. The payload the two share is a struct, and reproducing a
// struct type out of SPIR-V is exactly the guess this tool refuses to make.
//
// ## The stage codes are new
//
// The cache container calls these 9 and 10, which nothing had seen before. Both were
// established by construction rather than inference: a mesh-only pipeline deposits exactly one
// object, code 9; adding the amplification shader adds code 10. The banner reads
// `stage: mesh (code 9)`.

struct Meshlet { float4 bounds; float4 tint; };
StructuredBuffer<Meshlet> gMeshlets;
cbuffer View { float4x4 viewProj; float4 camera; }

struct Payload { uint meshlet; float lod; };
struct MeshVertex { float4 pos : SV_Position; float3 tint : COLOR0; float lod : TEXCOORD0; };

groupshared Payload gPayload;

[shader("amplification")]
[numthreads(1, 1, 1)]
void ampMain(uint3 gid : SV_GroupID)
{
    Meshlet m = gMeshlets[gid.x];
    float   d = length(m.bounds.xyz - camera.xyz);
    gPayload.meshlet = gid.x;
    gPayload.lod     = saturate(1.0f - d / max(camera.w, 1e-3f));
    // One group per surviving meshlet. A real cull would dispatch zero for a meshlet behind
    // the camera; this keeps the shape without the branch, so the listing stays readable.
    DispatchMesh(1, 1, 1, gPayload);
}

[shader("mesh")]
[numthreads(3, 1, 1)]
[outputtopology("triangle")]
void meshMain(uint3 tid : SV_DispatchThreadID, in payload Payload p,
              out vertices MeshVertex verts[3], out indices uint3 tris[1])
{
    SetMeshOutputCounts(3, 1);
    Meshlet m = gMeshlets[p.meshlet];

    const float3 corners[3] = { float3(-1, -1, 0), float3(1, -1, 0), float3(0, 1, 0) };
    uint i = tid.x;
    float3 world = m.bounds.xyz + corners[i] * m.bounds.w * (0.5f + p.lod);

    verts[i].pos  = mul(viewProj, float4(world, 1.0f));
    verts[i].tint = m.tint.rgb * p.lod;
    verts[i].lod  = p.lod;
    if (i == 0) tris[0] = uint3(0, 1, 2);
}
