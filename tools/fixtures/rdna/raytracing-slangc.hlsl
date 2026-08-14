#pragma pack_matrix(column_major)
#ifdef SLANG_HLSL_ENABLE_NVAPI
#include "nvHLSLExtns.h"
#endif

#ifndef __DXC_VERSION_MAJOR
// warning X3557: loop doesn't seem to do anything, forcing loop to unroll
#pragma warning(disable : 3557)
#endif


#line 12 "D:/Development/Repositories/gpu-isa-extractor/tools/fixtures/gfx/raytracing.slang"
struct SLANG_ParameterGroup_Camera_0
{
    float4x4 invViewProj_0;
    float4 origin_0;
};


#line 12
cbuffer Camera_0 : register(b0)
{
    SLANG_ParameterGroup_Camera_0 Camera_0;
}

#line 10
RaytracingAccelerationStructure gScene_0 : register(t0);


#line 11
RWTexture2D<float4 > gOutput_0 : register(u0);


struct Payload_0
{
    float3 colour_0;
    float hitT_0;
};


#line 19
[shader("raygeneration")]void rayGen()
{
    uint3 _S1 = DispatchRaysIndex();

#line 21
    uint2 pixel_0 = _S1.xy;
    uint3 _S2 = DispatchRaysDimensions();


    float4 target_0 = mul(Camera_0.invViewProj_0, float4((float2(pixel_0) + 0.5f) / float2(_S2.xy) * 2.0f - 1.0f, 1.0f, 1.0f));

    RayDesc ray_0;
    ray_0.Origin = Camera_0.origin_0.xyz;
    ray_0.Direction = normalize(target_0.xyz / target_0.w - Camera_0.origin_0.xyz);
    ray_0.TMin = 0.00100000004749745f;
    ray_0.TMax = 10000.0f;

    Payload_0 p_0;
    p_0.colour_0 = float3(0.0f, 0.0f, 0.0f);
    p_0.hitT_0 = -1.0f;
    RayDesc _S3 = ray_0;

#line 36
    TraceRay(gScene_0, 0U, 255U, 0U, 1U, 0U, _S3, p_0);

    gOutput_0[pixel_0] = float4(p_0.colour_0, 1.0f);
    return;
}

#pragma pack_matrix(column_major)
#ifdef SLANG_HLSL_ENABLE_NVAPI
#include "nvHLSLExtns.h"
#endif

#ifndef __DXC_VERSION_MAJOR
// warning X3557: loop doesn't seem to do anything, forcing loop to unroll
#pragma warning(disable : 3557)
#endif


#line 14 "D:/Development/Repositories/gpu-isa-extractor/tools/fixtures/gfx/raytracing.slang"
struct Payload_0
{
    float3 colour_0;
    float hitT_0;
};


#line 42
[shader("miss")]void missMain(inout Payload_0 p_0)
{
    float3 _S1 = float3(0.10000000149011612f, 0.20000000298023224f, 0.40000000596046448f);

#line 44
    float3 _S2 = float3(0.69999998807907104f, 0.80000001192092896f, 1.0f);
    float3 _S3 = WorldRayDirection();

#line 44
    p_0.colour_0 = lerp(_S1, _S2, (float3)saturate(_S3.y * 0.5f + 0.5f));

    p_0.hitT_0 = -1.0f;
    return;
}

#pragma pack_matrix(column_major)
#ifdef SLANG_HLSL_ENABLE_NVAPI
#include "nvHLSLExtns.h"
#endif

#ifndef __DXC_VERSION_MAJOR
// warning X3557: loop doesn't seem to do anything, forcing loop to unroll
#pragma warning(disable : 3557)
#endif


#line 15 "D:/Development/Repositories/gpu-isa-extractor/tools/fixtures/gfx/raytracing.slang"
struct SphereAttr_0
{
    float3 normal_0;
};


#line 52
[shader("intersection")]void sphereHit()
{
    float3 o_0 = ObjectRayOrigin();
    float3 d_0 = ObjectRayDirection();

    float b_0 = dot(o_0, d_0);

    float disc_0 = b_0 * b_0 - (dot(o_0, o_0) - 1.0f);
    if(disc_0 < 0.0f)
    {

#line 60
        return;
    }
    float root_0 = sqrt(disc_0);
    float _S1 = - b_0;

#line 63
    float t_0 = _S1 - root_0;
    float _S2 = RayTMin();

#line 64
    float t_1;

#line 64
    if(t_0 < _S2)
    {

#line 64
        t_1 = _S1 + root_0;

#line 64
    }
    else
    {

#line 64
        t_1 = t_0;

#line 64
    }
    float _S3 = RayTMin();

#line 65
    bool _S4;

#line 65
    if(t_1 < _S3)
    {

#line 65
        _S4 = true;

#line 65
    }
    else
    {

#line 65
        float _S5 = RayTCurrent();

#line 65
        _S4 = t_1 > _S5;

#line 65
    }

#line 65
    if(_S4)
    {

#line 65
        return;
    }
    SphereAttr_0 attr_0;
    attr_0.normal_0 = normalize(o_0 + d_0 * t_1);
    bool _S6 = (ReportHit((t_1), (0U), (attr_0)));
    return;
}

#pragma pack_matrix(column_major)
#ifdef SLANG_HLSL_ENABLE_NVAPI
#include "nvHLSLExtns.h"
#endif

#ifndef __DXC_VERSION_MAJOR
// warning X3557: loop doesn't seem to do anything, forcing loop to unroll
#pragma warning(disable : 3557)
#endif


#line 14 "D:/Development/Repositories/gpu-isa-extractor/tools/fixtures/gfx/raytracing.slang"
struct Payload_0
{
    float3 colour_0;
    float hitT_0;
};


#line 15
struct SphereAttr_0
{
    float3 normal_0;
};


#line 73
[shader("anyhit")]void anyHit(inout Payload_0 p_0, SphereAttr_0 attr_0)
{

    if((attr_0.normal_0.y) > 0.98000001907348633f)
    {

#line 76
        IgnoreHit();

#line 76
    }
    return;
}

#pragma pack_matrix(column_major)
#ifdef SLANG_HLSL_ENABLE_NVAPI
#include "nvHLSLExtns.h"
#endif

#ifndef __DXC_VERSION_MAJOR
// warning X3557: loop doesn't seem to do anything, forcing loop to unroll
#pragma warning(disable : 3557)
#endif


#line 16 "D:/Development/Repositories/gpu-isa-extractor/tools/fixtures/gfx/raytracing.slang"
struct Shade_0
{
    float3 colour_0;
};


#line 14
struct Payload_0
{
    float3 colour_1;
    float hitT_0;
};


#line 15
struct SphereAttr_0
{
    float3 normal_0;
};


#line 80
[shader("closesthit")]void closestHit(inout Payload_0 p_0, SphereAttr_0 attr_0)
{
    Shade_0 s_0;
    s_0.colour_0 = attr_0.normal_0 * 0.5f + 0.5f;
    CallShader(0U, s_0);

    float _S1 = RayTCurrent();

#line 86
    p_0.colour_1 = s_0.colour_0 * (1.0f / (1.0f + _S1 * 0.05000000074505806f));
    float _S2 = RayTCurrent();

#line 87
    p_0.hitT_0 = _S2;
    return;
}

#pragma pack_matrix(column_major)
#ifdef SLANG_HLSL_ENABLE_NVAPI
#include "nvHLSLExtns.h"
#endif

#ifndef __DXC_VERSION_MAJOR
// warning X3557: loop doesn't seem to do anything, forcing loop to unroll
#pragma warning(disable : 3557)
#endif


#line 16 "D:/Development/Repositories/gpu-isa-extractor/tools/fixtures/gfx/raytracing.slang"
struct Shade_0
{
    float3 colour_0;
};


#line 91
[shader("callable")]void tonemap(inout Shade_0 s_0)
{
    s_0.colour_0 = s_0.colour_0 / (s_0.colour_0 + 1.0f);
    return;
}

