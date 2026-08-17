// gpu-isa-extractor -O3
//
// A complete raytracing pipeline over procedural geometry - as an input for
// **NVIDIA ISA: Compile and Disassemble** (Ctrl+Alt+Shift+B).
//
// Every other stage in these samples is part of a chain: something feeds it, or it feeds
// something, and the extension synthesises whichever end is missing. Raytracing is not a chain.
// The six stages here are one pipeline, reachable from each other through shader groups rather
// than through varyings, and none of them can be compiled on its own. Name any entry point in
// this file and all six are compiled together, because that is what the driver is given.
//
// The one exception is the raygeneration shader, which is mandatory: it is the only stage a
// driver will start. Delete `rayGen` and the extension refuses the file by name rather than
// letting Vulkan produce an error about shader group 0.
//
// ## What to look for: a shader that comes apart
//
// Compiling this file gives eight listings for six shaders:
//
//   rayGen_ss_0          80 instructions, 66 registers
//   rayGen_ss_1          16                66
//   skyMiss              24                66
//   sphereIntersect     128                72
//   sphereMask           32                66
//   shadeSphere_ss_0     48                62
//   shadeSphere_ss_1     24                66
//   tonemap              32                62
//
// `rayGen` is two of them. That is not the extension splitting anything - it is what the driver
// deposited. `TraceRay` suspends the shader: the ray goes off to the traversal hardware, and
// the code after the call is scheduled as a separate program to be resumed when the ray is
// answered. The suffix is the driver's, and the listings are named after it rather than
// collapsed, because two pieces of separately scheduled code are not one shader with a gap in
// it. `shadeSphere` splits the same way, at its `CallShader`.
//
// The intersection shader is the largest thing here by some margin, which is the cost of
// procedural geometry stated plainly: 128 instructions of ray-sphere solve running where
// triangles would have used the traversal hardware's own intersector and no shader at all.
//
// ## What to look for: membership is the state
//
// A graphics pipeline's render state does not reach the microcode - the sample notes in
// `surface-shading.slang` measure that. A raytracing pipeline has almost no state to speak of,
// and what does reach the microcode is which shaders are in it:
//
//   drop `sphereMask` (any-hit)   every other stage byte-identical
//   drop `tonemap` (callable)     only `closestHit` changes - it is what calls it
//   drop the hit group entirely   `rayGen` changes; the trace has less to resume into
//
// The pattern is the one the graphics stages showed: a shader is narrowed by what it reaches,
// not by what reaches it. Adding `skyMiss` to a pipeline that had only `rayGen` leaves `rayGen`
// alone; adding the hit group does not.
//
// ## No acceleration structure is built
//
// `gScene` is a descriptor, and the pipeline is created against a descriptor set layout that
// says an acceleration structure lives at binding 0. Nothing is ever put there - no BLAS, no
// TLAS, no geometry, no ray is ever traced. Compiling a shader needs the layout, not the data,
// which is the same reason the other samples need no vertex buffer.

RaytracingAccelerationStructure gScene;
RWTexture2D<float4>             gOutput;
cbuffer Camera
{
    float4x4 invViewProj;
    float4   eye;
    float4   sunDirection;
}

struct Payload { float3 colour; float hitT; };
struct SphereHit { float3 normal; };
struct Tonemap { float3 colour; };

[shader("raygeneration")]
void rayGen()
{
    uint2  pixel = DispatchRaysIndex().xy;
    float2 ndc   = (float2(pixel) + 0.5f) / float2(DispatchRaysDimensions().xy) * 2.0f - 1.0f;

    float4 target = mul(invViewProj, float4(ndc, 1.0f, 1.0f));

    RayDesc ray;
    ray.Origin    = eye.xyz;
    ray.Direction = normalize(target.xyz / target.w - eye.xyz);
    ray.TMin      = 1e-3f;
    ray.TMax      = 1e4f;

    Payload p;
    p.colour = float3(0, 0, 0);
    p.hitT   = -1.0f;

    // Everything after this call is `rayGen_ss_1`.
    TraceRay(gScene, RAY_FLAG_NONE, 0xff, 0, 1, 0, ray, p);

    gOutput[pixel] = float4(p.colour, 1.0f);
}

// Nothing was hit, so the ray ends in the sky. A miss shader is a leaf - it is reached and
// reaches nothing, which is why adding one leaves the shader that traced the ray unchanged.
[shader("miss")]
void skyMiss(inout Payload p)
{
    float t = saturate(WorldRayDirection().y * 0.5f + 0.5f);
    p.colour = lerp(float3(0.12f, 0.18f, 0.32f), float3(0.72f, 0.82f, 0.98f), t);
    p.hitT   = -1.0f;
}

// The geometry is procedural: there are no triangles, and this shader is what decides where the
// surface is. A unit sphere per primitive, solved against the ray in object space. `ReportHit`
// hands the surface normal to the hit shaders as the attribute struct, which is the part a
// triangles hit group would get from the fixed-function intersector instead.
[shader("intersection")]
void sphereIntersect()
{
    float3 o = ObjectRayOrigin();
    float3 d = ObjectRayDirection();

    float b    = dot(o, d);
    float c    = dot(o, o) - 1.0f;
    float disc = b * b - c;
    if (disc < 0.0f) return;

    float root = sqrt(disc);
    float t    = -b - root;
    if (t < RayTMin()) t = -b + root;         // inside the sphere: take the far root
    if (t < RayTMin() || t > RayTCurrent()) return;

    SphereHit hit;
    hit.normal = normalize(o + d * t);
    ReportHit(t, 0u, hit);
}

// An any-hit shader runs for every candidate hit, not just the nearest, so it is where a cutout
// is applied. This one punches a hole through the top of each sphere. It reaches nothing, and
// removing it changes no other stage.
[shader("anyhit")]
void sphereMask(inout Payload p, SphereHit hit)
{
    if (hit.normal.y > 0.96f) IgnoreHit();
}

[shader("closesthit")]
void shadeSphere(inout Payload p, SphereHit hit)
{
    float lambert = saturate(dot(hit.normal, normalize(sunDirection.xyz)));

    Tonemap t;
    t.colour = (hit.normal * 0.5f + 0.5f) * (0.15f + 0.85f * lambert);
    // Everything after this call is `shadeSphere_ss_1`, and taking `tonemap` out of the
    // pipeline is what changes this shader and nothing else.
    CallShader(0, t);

    p.colour = t.colour;
    p.hitT   = RayTCurrent();
}

// A callable shader is a function the pipeline can dispatch by index. It exists here to be the
// thing `shadeSphere` reaches, so that dropping it has something to measure.
[shader("callable")]
void tonemap(inout Tonemap t)
{
    t.colour = t.colour / (t.colour + 1.0f);
    t.colour = pow(t.colour, 1.0f / 2.2f);
}
