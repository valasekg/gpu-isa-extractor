// gpu-isa-extractor -O3
//
// A shadow ray traced from inside a fragment shader, as an input for
// **NVIDIA ISA: Compile and Disassemble** (Ctrl+Alt+Shift+B).
//
// This is *inline* ray tracing - `RayQuery` and `TraceRayInline`, what D3D12 calls DXR 1.1 -
// and it is a different thing from a raytracing pipeline. There is no raygen shader, no miss
// shader, no hit group and no shader binding table. The ray is traced in the middle of an
// ordinary fragment shader, and the acceleration structure it walks is bound as an ordinary
// descriptor. So it needs no new pipeline machinery at all: this file compiles through exactly
// the same road `surface-shading.slang` takes.
//
// ## What it compiles to
//
// 408 instructions in 39 registers - by far the largest listing in `samples/`, and almost all
// of it is the traversal:
//
//   LOP3.LUT x93             bit manipulation, the bulk of the listing
//   SHF / PRMT               shifts and byte permutes, unpacking node data
//   LDG.E.CONSTANT           walking the acceleration structure out of memory
//   CALL.REL.NOINC           a relative call - the traversal is not fully flattened
//   BSSY / BSYNC x7          seven divergence regions, because rays in a warp take different
//                            paths through the tree
//
// What is NOT in the listing is any instruction nvdisasm names as ray-tracing specific. Make
// of that what you will - this sample does not claim to know whether the RT cores are engaged
// through instructions nvdisasm decodes as something else, or whether this path is traversal
// in software. It is a good example of the question a SASS listing can raise and not settle
// on its own.
//
// ## What it cost the tooling
//
// Nothing, and that is the interesting part - twice over.
//
// The first time this compiled it produced the same 408 instructions and looked entirely
// correct. It was not: the pipeline declared the `RayQueryKHR` capability and the
// `SPV_KHR_ray_query` extension without either being enabled on the device, and the
// acceleration-structure descriptor needed `VK_KHR_acceleration_structure`. Nine validation
// errors, none of them visible in the output, and the driver built it anyway. That is the
// third time this driver has compiled an invalid pipeline into plausible-looking code.
//
// The fix is why the extension now reads the capabilities a module *declares* out of its
// SPIR-V and enables exactly those, rather than carrying a hardcoded list. A shader that asks
// for something is the only reliable statement of what it needs.

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
