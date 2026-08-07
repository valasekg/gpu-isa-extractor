// The fixture behind the raytracing section of test_gfx.js. It declares all six raytracing
// stages, because the point of the fixture is that one file becomes one pipeline: the
// raygeneration shader is the only stage a driver will start, and the other five are reachable
// only through the shader groups built around it.
//
// The hit shaders answer for procedural geometry - an intersection shader decides the hit and
// hands over its own attribute struct - so the hit group is procedural rather than triangles.
// That is the shape that exercises the intersection stage; a triangles group would leave it out.

RaytracingAccelerationStructure gScene;
RWTexture2D<float4>             gOutput;
cbuffer Camera { float4x4 invViewProj; float4 origin; }

struct Payload { float3 colour; float hitT; };
struct SphereAttr { float3 normal; };
struct Shade { float3 colour; };

[shader("raygeneration")]
void rayGen()
{
    uint2 pixel = DispatchRaysIndex().xy;
    uint2 dims  = DispatchRaysDimensions().xy;
    float2 ndc  = (float2(pixel) + 0.5f) / float2(dims) * 2.0f - 1.0f;

    float4 target = mul(invViewProj, float4(ndc, 1.0f, 1.0f));

    RayDesc ray;
    ray.Origin    = origin.xyz;
    ray.Direction = normalize(target.xyz / target.w - origin.xyz);
    ray.TMin      = 1e-3f;
    ray.TMax      = 1e4f;

    Payload p;
    p.colour = float3(0, 0, 0);
    p.hitT   = -1.0f;
    TraceRay(gScene, RAY_FLAG_NONE, 0xff, 0, 1, 0, ray, p);

    gOutput[pixel] = float4(p.colour, 1.0f);
}

[shader("miss")]
void missMain(inout Payload p)
{
    p.colour = lerp(float3(0.1f, 0.2f, 0.4f), float3(0.7f, 0.8f, 1.0f),
                    saturate(WorldRayDirection().y * 0.5f + 0.5f));
    p.hitT = -1.0f;
}

// A unit sphere at the primitive's origin, solved against the ray in object space. The hit is
// reported with the surface normal, which is what the closest-hit shader shades from.
[shader("intersection")]
void sphereHit()
{
    float3 o = ObjectRayOrigin();
    float3 d = ObjectRayDirection();

    float b = dot(o, d);
    float c = dot(o, o) - 1.0f;
    float disc = b * b - c;
    if (disc < 0.0f) return;

    float root = sqrt(disc);
    float t = -b - root;
    if (t < RayTMin()) t = -b + root;
    if (t < RayTMin() || t > RayTCurrent()) return;

    SphereAttr attr;
    attr.normal = normalize(o + d * t);
    ReportHit(t, 0u, attr);
}

[shader("anyhit")]
void anyHit(inout Payload p, SphereAttr attr)
{
    // A cheap stand-in for an alpha test: the pole of every sphere is transparent.
    if (attr.normal.y > 0.98f) IgnoreHit();
}

[shader("closesthit")]
void closestHit(inout Payload p, SphereAttr attr)
{
    Shade s;
    s.colour = attr.normal * 0.5f + 0.5f;
    CallShader(0, s);

    p.colour = s.colour * (1.0f / (1.0f + RayTCurrent() * 0.05f));
    p.hitT   = RayTCurrent();
}

[shader("callable")]
void tonemap(inout Shade s)
{
    s.colour = s.colour / (s.colour + 1.0f);
}
