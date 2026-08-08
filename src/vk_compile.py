#!/usr/bin/env python3
"""Make the GPU driver compile a graphics shader, by creating one Vulkan pipeline.

A vertex or fragment shader has no CUDA lowering, so the `.slang -> .cu -> .ptx -> .cubin`
route this extension uses for compute cannot reach it - `slangc -stage fragment -target cuda`
crashes outright. The only compiler that turns a graphics shader into SASS is the one inside
the display driver, and the only way to ask it is to create a pipeline. That is all this file
does: no swapchain, no images, no render pass, no draw. Dynamic rendering is what makes that
possible, because the colour and depth formats become pipeline state rather than properties of
a VkRenderPass that would need real attachments behind it.

Run with `__GL_SHADER_DISK_CACHE_PATH` pointed at a fresh directory and the driver's output is
the only thing in it, ready for the same carve the cache path already performs.

## Why Python

Vulkan is a C API behind a loader, and the extension host cannot call native code - the same
problem `nvrtc_compile.py` has with NVRTC, solved the same way, for the same reason: a ctypes
file needs no build step, no npm, and no per-platform binary in the VSIX. Measured on this
machine, this file reproduces a C++ harness's microcode byte for byte, and every struct
layout matches what MSVC computes from the real headers.

## Contract

    py vk_compile.py <request.json>
    py vk_compile.py --probe        # which loader, which devices; compile nothing
    py vk_compile.py --layout       # sizeof/offsetof per struct, for the ABI cross-check

    {"vs": "producer.spv",          # a graphics pipeline: vs or ms is required
     "fs": "shader.spv",            # or null for rasterizer discard
     "gs": "geometry.spv",          # optional geometry stage
     "hs": "hull.spv",              # tessellation, both halves or neither
     "ds": "domain.spv",
     "ms": "mesh.spv",              # the mesh road, which has no vertex stage
     "ts": "task.spv",              # its amplification stage, optional

     "rgen": "raygen.spv",          # a raytracing pipeline instead: rgen is required, and
     "miss": "miss.spv",            # cannot be combined with any stage above
     "chit": "closesthit.spv",
     "ahit": "anyhit.spv",
     "sect": "intersection.spv",    # its presence makes the hit group procedural
     "call": "callable.spv",

     "layout": {"bindings": [[set, binding, descriptorType, count]], "pushBytes": 0},
     "state": {"format": "r8g8b8a8_unorm", "samples": 1, "depth": "none",
               "topology": "triangle_list", "patchControlPoints": 0},
     "validate": false,             # run under the validation layer and make it fatal
     "checkInterface": true,
     "checkTopology": true,
     "loader": null}

Exit codes: 0 created, 1 the driver refused the pipeline, 2 Vulkan unusable or the request is
bad, 3 this interpreter cannot be used, 4 the driver faulted, 5 the validation layer says the
pipeline is invalid.

## Why `validate` exists

This driver is lenient, and lenience is the problem. Twice now a pipeline has been built from
an invalid request, been compiled anyway, and returned microcode that matched an independent
C++ harness byte for byte - once because `dynamicRendering` was never enabled (the 1.3
features struct carried the sType of the 1.1 one), and once because a module declared the
DrawParameters capability that no feature had turned on. No digest, no struct-layout diff and
no exit code could see either. The validation layer saw both immediately.

So `validate: true` turns the layer on, attaches a debug messenger, and makes what it says
fatal - and `tools/test_gfx.js` runs every fixture that way. It needs the Vulkan SDK, which
ships the layer; the display driver does not.
"""

import ctypes as C
import faulthandler
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

EXIT_OK, EXIT_REFUSED, EXIT_UNUSABLE, EXIT_INTERPRETER, EXIT_FAULTED = 0, 1, 2, 3, 4
EXIT_INVALID = 5           # the pipeline was built, and the validation layer says it is invalid

# ---------------------------------------------------------------- base types
u32, i32, f32, sz = C.c_uint32, C.c_int32, C.c_float, C.c_size_t
VkBool32 = C.c_uint32
VkFlags = C.c_uint32
VkEnum = C.c_int32           # every Vulkan enum is pinned to 32 bits by its _MAX_ENUM member
Handle = C.c_void_p          # dispatchable: VkInstance/VkPhysicalDevice/VkDevice
NonDisp = C.c_uint64         # non-dispatchable: VkShaderModule/VkPipeline/... always 64 bits
VOID = C.c_void_p

VK_SUCCESS = 0
VK_TRUE, VK_FALSE = 1, 0
VK_NULL_HANDLE = 0


def api_version(major, minor, patch=0):
    return (major << 22) | (minor << 12) | patch


# ---------------------------------------------------------------- structs
class VkExtent3D(C.Structure):
    _fields_ = [("width", u32), ("height", u32), ("depth", u32)]


class VkApplicationInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID),
                ("pApplicationName", C.c_char_p), ("applicationVersion", u32),
                ("pEngineName", C.c_char_p), ("engineVersion", u32), ("apiVersion", u32)]


class VkInstanceCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("pApplicationInfo", C.POINTER(VkApplicationInfo)),
                ("enabledLayerCount", u32), ("ppEnabledLayerNames", VOID),
                ("enabledExtensionCount", u32), ("ppEnabledExtensionNames", VOID)]


# vkGetPhysicalDeviceProperties writes 824 bytes, almost all of it VkPhysicalDeviceLimits -
# 110 fields nobody here reads. Declaring only the prefix and letting the driver write past the
# end of the allocation is a heap smash, so the tail is reserved rather than described.
class VkPhysicalDeviceProperties(C.Structure):
    _fields_ = [("apiVersion", u32), ("driverVersion", u32),
                ("vendorID", u32), ("deviceID", u32), ("deviceType", VkEnum),
                ("deviceName", C.c_char * 256), ("pipelineCacheUUID", C.c_uint8 * 16),
                ("_tail", C.c_uint8 * 4096)]


class VkLayerProperties(C.Structure):
    _fields_ = [("layerName", C.c_char * 256), ("specVersion", u32),
                ("implementationVersion", u32), ("description", C.c_char * 256)]


# Only the prefix is described, because only `pMessage` is read - but the driver writes the
# whole thing, so the rest is reserved rather than left off the end of the allocation.
class VkDebugUtilsMessengerCallbackDataEXT(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("pMessageIdName", C.c_char_p), ("messageIdNumber", i32),
                ("pMessage", C.c_char_p), ("_tail", C.c_uint8 * 256)]


# The callback signature, as a ctypes trampoline. `CFUNCTYPE` rather than `WINFUNCTYPE`
# because VKAPI_PTR is __stdcall only on 32-bit Windows, and a 32-bit interpreter is refused
# outright before any of this runs.
DEBUG_CALLBACK = C.CFUNCTYPE(VkBool32, VkFlags, VkFlags,
                             C.POINTER(VkDebugUtilsMessengerCallbackDataEXT), VOID)


class VkDebugUtilsMessengerCreateInfoEXT(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("messageSeverity", VkFlags), ("messageType", VkFlags),
                ("pfnUserCallback", DEBUG_CALLBACK), ("pUserData", VOID)]


class VkQueueFamilyProperties(C.Structure):
    _fields_ = [("queueFlags", VkFlags), ("queueCount", u32),
                ("timestampValidBits", u32), ("minImageTransferGranularity", VkExtent3D)]


class VkDeviceQueueCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("queueFamilyIndex", u32), ("queueCount", u32),
                ("pQueuePriorities", C.POINTER(f32))]


# All 55 of them, in order, because `pEnabledFeatures` is a pointer to the whole struct and
# the driver reads every field: declaring a prefix would have it read whatever follows in
# memory as the features nobody set. Only two are ever turned on here.
class VkPhysicalDeviceFeatures(C.Structure):
    _fields_ = [(n, VkBool32) for n in (
        "robustBufferAccess", "fullDrawIndexUint32", "imageCubeArray", "independentBlend",
        "geometryShader", "tessellationShader", "sampleRateShading", "dualSrcBlend", "logicOp",
        "multiDrawIndirect", "drawIndirectFirstInstance", "depthClamp", "depthBiasClamp",
        "fillModeNonSolid", "depthBounds", "wideLines", "largePoints", "alphaToOne",
        "multiViewport", "samplerAnisotropy", "textureCompressionETC2",
        "textureCompressionASTC_LDR", "textureCompressionBC", "occlusionQueryPrecise",
        "pipelineStatisticsQuery", "vertexPipelineStoresAndAtomics", "fragmentStoresAndAtomics",
        "shaderTessellationAndGeometryPointSize", "shaderImageGatherExtended",
        "shaderStorageImageExtendedFormats", "shaderStorageImageMultisample",
        "shaderStorageImageReadWithoutFormat", "shaderStorageImageWriteWithoutFormat",
        "shaderUniformBufferArrayDynamicIndexing", "shaderSampledImageArrayDynamicIndexing",
        "shaderStorageBufferArrayDynamicIndexing", "shaderStorageImageArrayDynamicIndexing",
        "shaderClipDistance", "shaderCullDistance", "shaderFloat64", "shaderInt64",
        "shaderInt16", "shaderResourceResidency", "shaderResourceMinLod", "sparseBinding",
        "sparseResidencyBuffer", "sparseResidencyImage2D", "sparseResidencyImage3D",
        "sparseResidency2Samples", "sparseResidency4Samples", "sparseResidency8Samples",
        "sparseResidency16Samples", "sparseResidencyAliased", "variableMultisampleRate",
        "inheritedQueries")]


# The core features are requested through Features2 chained into pNext, with the 1.3 features
# chained off THAT, rather than through `pEnabledFeatures` alongside it. Both spellings look
# legal, and the second one silently loses `dynamicRendering` here - the validation layer
# catches it as VUID-VkGraphicsPipelineCreateInfo-dynamicRendering-06576 while the driver
# creates the pipeline anyway. One chain, one answer.
class VkPhysicalDeviceFeatures2(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("features", VkPhysicalDeviceFeatures)]


# Chained for one field: `shaderDrawParameters`. Slang lowers `SV_VertexID` to a form that
# declares the SPIR-V DrawParameters capability, and a module declaring a capability the device
# never enabled is an invalid pipeline - VUID-VkShaderModuleCreateInfo-pCode-08740. This driver
# compiles it anyway; the validation layer is the only thing that says otherwise.
# Mesh shading is an extension rather than core, so its features arrive in their own
# struct and the device extension has to be enabled alongside them.
# Ray query lives inside an ORDINARY shader - no raytracing pipeline, no shader groups -
# so it needs nothing here but the features and extensions the modules declare. Which is the
# whole point: `RayQuery` reached a working listing through the existing graphics path, and
# only the validation layer noticed the pipeline was invalid while it did so.
class VkPhysicalDeviceRayQueryFeaturesKHR(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("rayQuery", VkBool32)]


class VkPhysicalDeviceAccelerationStructureFeaturesKHR(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID)] + [
        (n, VkBool32) for n in (
            "accelerationStructure", "accelerationStructureCaptureReplay",
            "accelerationStructureIndirectBuild", "accelerationStructureHostCommands",
            "descriptorBindingAccelerationStructureUpdateAfterBind")]


class VkPhysicalDeviceRayTracingPipelineFeaturesKHR(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID)] + [
        (n, VkBool32) for n in (
            "rayTracingPipeline", "rayTracingPipelineShaderGroupHandleCaptureReplay",
            "rayTracingPipelineShaderGroupHandleCaptureReplayMixed",
            "rayTracingPipelineTraceRaysIndirect", "rayTraversalPrimitiveCulling")]


class VkPhysicalDeviceBufferDeviceAddressFeatures(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID)] + [
        (n, VkBool32) for n in (
            "bufferDeviceAddress", "bufferDeviceAddressCaptureReplay",
            "bufferDeviceAddressMultiDevice")]


class VkPhysicalDeviceMeshShaderFeaturesEXT(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID)] + [
        (n, VkBool32) for n in (
            "taskShader", "meshShader", "multiviewMeshShader",
            "primitiveFragmentShadingRateMeshShader", "meshShaderQueries")]


class VkPhysicalDeviceVulkan11Features(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID)] + [
        (n, VkBool32) for n in (
            "storageBuffer16BitAccess", "uniformAndStorageBuffer16BitAccess",
            "storagePushConstant16", "storageInputOutput16", "multiview",
            "multiviewGeometryShader", "multiviewTessellationShader",
            "variablePointersStorageBuffer", "variablePointers", "protectedMemory",
            "samplerYcbcrConversion", "shaderDrawParameters")]


class VkPhysicalDeviceVulkan13Features(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID)] + [
        (n, VkBool32) for n in (
            "robustImageAccess", "inlineUniformBlock",
            "descriptorBindingInlineUniformBlockUpdateAfterBind",
            "pipelineCreationCacheControl", "privateData",
            "shaderDemoteToHelperInvocation", "shaderTerminateInvocation",
            "subgroupSizeControl", "computeFullSubgroups", "synchronization2",
            "textureCompressionASTC_HDR", "shaderZeroInitializeWorkgroupMemory",
            "dynamicRendering", "shaderIntegerDotProduct", "maintenance4")]


class VkDeviceCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("queueCreateInfoCount", u32),
                ("pQueueCreateInfos", C.POINTER(VkDeviceQueueCreateInfo)),
                ("enabledLayerCount", u32), ("ppEnabledLayerNames", VOID),
                ("enabledExtensionCount", u32), ("ppEnabledExtensionNames", VOID),
                ("pEnabledFeatures", VOID)]


class VkShaderModuleCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("codeSize", sz), ("pCode", VOID)]


class VkDescriptorSetLayoutBinding(C.Structure):
    _fields_ = [("binding", u32), ("descriptorType", VkEnum), ("descriptorCount", u32),
                ("stageFlags", VkFlags), ("pImmutableSamplers", VOID)]


class VkDescriptorSetLayoutCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("bindingCount", u32),
                ("pBindings", C.POINTER(VkDescriptorSetLayoutBinding))]


class VkPushConstantRange(C.Structure):
    _fields_ = [("stageFlags", VkFlags), ("offset", u32), ("size", u32)]


class VkPipelineLayoutCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("setLayoutCount", u32), ("pSetLayouts", C.POINTER(NonDisp)),
                ("pushConstantRangeCount", u32),
                ("pPushConstantRanges", C.POINTER(VkPushConstantRange))]


class VkPipelineShaderStageCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("stage", VkFlags), ("module", NonDisp),
                ("pName", C.c_char_p), ("pSpecializationInfo", VOID)]


class VkPipelineVertexInputStateCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("vertexBindingDescriptionCount", u32), ("pVertexBindingDescriptions", VOID),
                ("vertexAttributeDescriptionCount", u32),
                ("pVertexAttributeDescriptions", VOID)]


class VkPipelineInputAssemblyStateCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("topology", VkEnum), ("primitiveRestartEnable", VkBool32)]


class VkPipelineTessellationStateCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("patchControlPoints", u32)]


class VkPipelineViewportStateCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("viewportCount", u32), ("pViewports", VOID),
                ("scissorCount", u32), ("pScissors", VOID)]


class VkPipelineRasterizationStateCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("depthClampEnable", VkBool32), ("rasterizerDiscardEnable", VkBool32),
                ("polygonMode", VkEnum), ("cullMode", VkFlags), ("frontFace", VkEnum),
                ("depthBiasEnable", VkBool32), ("depthBiasConstantFactor", f32),
                ("depthBiasClamp", f32), ("depthBiasSlopeFactor", f32), ("lineWidth", f32)]


class VkPipelineMultisampleStateCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("rasterizationSamples", VkFlags), ("sampleShadingEnable", VkBool32),
                ("minSampleShading", f32), ("pSampleMask", VOID),
                ("alphaToCoverageEnable", VkBool32), ("alphaToOneEnable", VkBool32)]


class VkStencilOpState(C.Structure):
    _fields_ = [("failOp", VkEnum), ("passOp", VkEnum), ("depthFailOp", VkEnum),
                ("compareOp", VkEnum), ("compareMask", u32), ("writeMask", u32),
                ("reference", u32)]


class VkPipelineDepthStencilStateCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("depthTestEnable", VkBool32), ("depthWriteEnable", VkBool32),
                ("depthCompareOp", VkEnum), ("depthBoundsTestEnable", VkBool32),
                ("stencilTestEnable", VkBool32), ("front", VkStencilOpState),
                ("back", VkStencilOpState), ("minDepthBounds", f32), ("maxDepthBounds", f32)]


class VkPipelineColorBlendAttachmentState(C.Structure):
    _fields_ = [("blendEnable", VkBool32), ("srcColorBlendFactor", VkEnum),
                ("dstColorBlendFactor", VkEnum), ("colorBlendOp", VkEnum),
                ("srcAlphaBlendFactor", VkEnum), ("dstAlphaBlendFactor", VkEnum),
                ("alphaBlendOp", VkEnum), ("colorWriteMask", VkFlags)]


class VkPipelineColorBlendStateCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("logicOpEnable", VkBool32), ("logicOp", VkEnum), ("attachmentCount", u32),
                ("pAttachments", C.POINTER(VkPipelineColorBlendAttachmentState)),
                ("blendConstants", f32 * 4)]


class VkPipelineDynamicStateCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("dynamicStateCount", u32), ("pDynamicStates", C.POINTER(VkEnum))]


class VkPipelineRenderingCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("viewMask", u32),
                ("colorAttachmentCount", u32), ("pColorAttachmentFormats", C.POINTER(VkEnum)),
                ("depthAttachmentFormat", VkEnum), ("stencilAttachmentFormat", VkEnum)]


# A raytracing pipeline is a different kind of object, not another stage in the graphics
# one: a different creation call, shader GROUPS instead of a fixed stage order, and none of
# the render state - no vertex input, no rasterizer, no attachments, no dynamic rendering.
class VkRayTracingShaderGroupCreateInfoKHR(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("type", VkEnum),
                ("generalShader", u32), ("closestHitShader", u32),
                ("anyHitShader", u32), ("intersectionShader", u32),
                ("pShaderGroupCaptureReplayHandle", VOID)]


class VkRayTracingPipelineCreateInfoKHR(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("stageCount", u32),
                ("pStages", C.POINTER(VkPipelineShaderStageCreateInfo)),
                ("groupCount", u32),
                ("pGroups", C.POINTER(VkRayTracingShaderGroupCreateInfoKHR)),
                ("maxPipelineRayRecursionDepth", u32),
                ("pLibraryInfo", VOID), ("pLibraryInterface", VOID),
                ("pDynamicState", VOID),
                ("layout", NonDisp), ("basePipelineHandle", NonDisp),
                ("basePipelineIndex", i32)]


class VkGraphicsPipelineCreateInfo(C.Structure):
    _fields_ = [("sType", VkEnum), ("pNext", VOID), ("flags", VkFlags),
                ("stageCount", u32),
                ("pStages", C.POINTER(VkPipelineShaderStageCreateInfo)),
                ("pVertexInputState", C.POINTER(VkPipelineVertexInputStateCreateInfo)),
                ("pInputAssemblyState", C.POINTER(VkPipelineInputAssemblyStateCreateInfo)),
                ("pTessellationState", VOID),
                ("pViewportState", C.POINTER(VkPipelineViewportStateCreateInfo)),
                ("pRasterizationState", C.POINTER(VkPipelineRasterizationStateCreateInfo)),
                ("pMultisampleState", C.POINTER(VkPipelineMultisampleStateCreateInfo)),
                ("pDepthStencilState", C.POINTER(VkPipelineDepthStencilStateCreateInfo)),
                ("pColorBlendState", C.POINTER(VkPipelineColorBlendStateCreateInfo)),
                ("pDynamicState", C.POINTER(VkPipelineDynamicStateCreateInfo)),
                ("layout", NonDisp), ("renderPass", NonDisp), ("subpass", u32),
                ("basePipelineHandle", NonDisp), ("basePipelineIndex", i32)]


# Every ctypes Structure this file defines, discovered rather than listed.
#
# It used to be a hand-written list, and `tools/vk_abi_freeze.py` generates its C from that same
# list - so the suite's "neither side declares a struct the other does not" check compared a set
# against a copy of itself and could never find a struct that was USED but never frozen. Three
# already were: VkPhysicalDeviceProperties (which picks the GPU and names it in the banner),
# VkDebugUtilsMessengerCallbackDataEXT (dereferenced in the validation callback) and VkExtent3D.
# Reading the module's own namespace means a new Structure is frozen by existing, which is the
# only version of this that cannot drift.
def _declared_structs():
    import sys as _sys
    module = _sys.modules[__name__]
    out = []
    for name in dir(module):
        obj = getattr(module, name)
        if isinstance(obj, type) and issubclass(obj, C.Structure) and obj is not C.Structure:
            out.append(obj)
    return sorted(out, key=lambda s: s.__name__)


LAYOUT_ORDER = [
    VkApplicationInfo, VkInstanceCreateInfo, VkQueueFamilyProperties,
    VkDeviceQueueCreateInfo, VkPhysicalDeviceFeatures, VkPhysicalDeviceFeatures2,
    VkPhysicalDeviceVulkan11Features, VkPhysicalDeviceMeshShaderFeaturesEXT,
    VkPhysicalDeviceRayQueryFeaturesKHR,
    VkPhysicalDeviceAccelerationStructureFeaturesKHR,
    VkPhysicalDeviceRayTracingPipelineFeaturesKHR,
    VkPhysicalDeviceBufferDeviceAddressFeatures,
    VkLayerProperties,
    VkDebugUtilsMessengerCreateInfoEXT,
    VkPhysicalDeviceVulkan13Features, VkDeviceCreateInfo,
    VkShaderModuleCreateInfo, VkDescriptorSetLayoutBinding, VkDescriptorSetLayoutCreateInfo,
    VkPushConstantRange, VkPipelineLayoutCreateInfo, VkPipelineShaderStageCreateInfo,
    VkPipelineVertexInputStateCreateInfo, VkPipelineInputAssemblyStateCreateInfo,
    VkPipelineTessellationStateCreateInfo,
    VkPipelineViewportStateCreateInfo, VkPipelineRasterizationStateCreateInfo,
    VkPipelineMultisampleStateCreateInfo, VkStencilOpState,
    VkPipelineDepthStencilStateCreateInfo, VkPipelineColorBlendAttachmentState,
    VkPipelineColorBlendStateCreateInfo, VkPipelineDynamicStateCreateInfo,
    VkPipelineRenderingCreateInfo, VkGraphicsPipelineCreateInfo,
    VkRayTracingShaderGroupCreateInfoKHR, VkRayTracingPipelineCreateInfoKHR,
]

# The declared order first, so the generated C and the frozen file keep their familiar shape,
# then anything the list forgot.
LAYOUT_STRUCTS = LAYOUT_ORDER + [s for s in _declared_structs() if s not in LAYOUT_ORDER]


def layout_report():
    """sizeof and every offsetof, so a C compiler can be asked whether ctypes agrees."""
    out = {}
    for s in LAYOUT_STRUCTS:
        out[s.__name__] = {
            "sizeof": C.sizeof(s),
            "fields": {n: getattr(s, n).offset
                       for n, *_ in s._fields_ if not n.startswith("_")},
        }
    return out


# ---------------------------------------------------------------- constants
ST = dict(
    APPLICATION_INFO=0, INSTANCE_CREATE_INFO=1, DEVICE_QUEUE_CREATE_INFO=2,
    DEVICE_CREATE_INFO=3, SHADER_MODULE_CREATE_INFO=16, PIPELINE_SHADER_STAGE_CREATE_INFO=18,
    PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO=19, PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO=20,
    PIPELINE_VIEWPORT_STATE_CREATE_INFO=22, PIPELINE_RASTERIZATION_STATE_CREATE_INFO=23,
    PIPELINE_MULTISAMPLE_STATE_CREATE_INFO=24, PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO=25,
    PIPELINE_COLOR_BLEND_STATE_CREATE_INFO=26, PIPELINE_DYNAMIC_STATE_CREATE_INFO=27,
    GRAPHICS_PIPELINE_CREATE_INFO=28, DESCRIPTOR_SET_LAYOUT_CREATE_INFO=32,
    PIPELINE_TESSELLATION_STATE_CREATE_INFO=21,
    PIPELINE_LAYOUT_CREATE_INFO=30,
    # 53, not 49. 49 is PHYSICAL_DEVICE_VULKAN_1_1_FEATURES, and a struct chained under it is
    # read as a 1.1 feature block - where `dynamicRendering` does not exist, so it is silently
    # never enabled. Nothing caught that: the microcode still matched a C++ harness byte for
    # byte, because this driver permits `renderPass = VK_NULL_HANDLE` regardless. Only the
    # validation layer objected. The ABI check cannot find a fault like this - it compares
    # struct layouts, and these are values - so `--validate` exists to make the layer's opinion
    # part of the suite.
    DEBUG_UTILS_MESSENGER_CREATE_INFO_EXT=1000128004,
    PHYSICAL_DEVICE_MESH_SHADER_FEATURES_EXT=1000328000,
    RAY_TRACING_PIPELINE_CREATE_INFO_KHR=1000150015,
    RAY_TRACING_SHADER_GROUP_CREATE_INFO_KHR=1000150016,
    PHYSICAL_DEVICE_RAY_QUERY_FEATURES_KHR=1000348013,
    PHYSICAL_DEVICE_ACCELERATION_STRUCTURE_FEATURES_KHR=1000150013,
    PHYSICAL_DEVICE_RAY_TRACING_PIPELINE_FEATURES_KHR=1000347000,
    PHYSICAL_DEVICE_BUFFER_DEVICE_ADDRESS_FEATURES=1000257000,
    PHYSICAL_DEVICE_FEATURES_2=1000059000, PHYSICAL_DEVICE_VULKAN_1_1_FEATURES=49,
    PHYSICAL_DEVICE_VULKAN_1_3_FEATURES=53, PIPELINE_RENDERING_CREATE_INFO=1000044002,
)

COLOUR = {"r8g8b8a8_unorm": 37, "b8g8r8a8_unorm": 44, "r8g8b8a8_srgb": 43,
          "a2b10g10r10": 64, "r16g16b16a16_sf": 97, "r32g32b32a32_sf": 109,
          "r32g32b32a32_ui": 107, "r16g16b16a16_ui": 95}
DEPTH = {"none": 0, "d16": 124, "d32": 126, "d24s8": 129, "d32s8": 130}

VK_SHADER_STAGE_VERTEX_BIT = 0x1
VK_SHADER_STAGE_TESSELLATION_CONTROL_BIT = 0x2      # hull
VK_SHADER_STAGE_TESSELLATION_EVALUATION_BIT = 0x4   # domain
VK_SHADER_STAGE_GEOMETRY_BIT = 0x8
VK_SHADER_STAGE_TASK_BIT_EXT = 0x40                 # amplification
VK_SHADER_STAGE_MESH_BIT_EXT = 0x80
VK_SHADER_STAGE_RAYGEN_BIT_KHR = 0x100
VK_SHADER_STAGE_ANY_HIT_BIT_KHR = 0x200
VK_SHADER_STAGE_CLOSEST_HIT_BIT_KHR = 0x400
VK_SHADER_STAGE_MISS_BIT_KHR = 0x800
VK_SHADER_STAGE_INTERSECTION_BIT_KHR = 0x1000
VK_SHADER_STAGE_CALLABLE_BIT_KHR = 0x2000

VK_SHADER_UNUSED_KHR = 0xFFFFFFFF
GROUP_GENERAL = 0
GROUP_TRIANGLES_HIT = 1
GROUP_PROCEDURAL_HIT = 2
VK_SHADER_STAGE_FRAGMENT_BIT = 0x10
VK_SHADER_STAGE_ALL_GRAPHICS = 0x1F
VK_QUEUE_GRAPHICS_BIT = 0x1
VK_POLYGON_MODE_FILL = 0
VK_CULL_MODE_NONE = 0
VK_FRONT_FACE_COUNTER_CLOCKWISE = 0
VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST = 3

# A geometry shader declares what primitive it consumes, and the input assembler has to be
# told to hand it that - a triangle-input GS behind a point-list topology is not a pipeline.
TOPOLOGY = {
    "point_list": 0, "line_list": 1, "triangle_list": 3,
    "line_list_with_adjacency": 6, "triangle_list_with_adjacency": 7,
    # Tessellation consumes patches and nothing else; the patch SIZE is separate state.
    "patch_list": 10,
}
VK_COMPARE_OP_LESS = 1
VK_COLOR_COMPONENT_RGBA = 0xF
VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR = 0, 1

VK_ERROR_INCOMPATIBLE_DRIVER = -9

VALIDATION_LAYER = b"VK_LAYER_KHRONOS_validation"
DEBUG_UTILS_EXTENSION = b"VK_EXT_debug_utils"
SEVERITY_WARNING = 0x100
SEVERITY_ERROR = 0x1000
MESSAGE_TYPE_ALL = 0x7
MESH_EXTENSION = b"VK_EXT_mesh_shader"

# SPIR-V capability numbers a module can declare that the device has to be told about.
# Derived from the modules rather than hardcoded, because a capability declared and never
# enabled is an invalid pipeline this driver builds anyway - three times measured now.
# Checked against spirv.h, not inferred: RayQueryKHR is 4472 and RayTracingKHR is 4479.
# These were the other way round at first and the ray-query fixture did not notice,
# because it declares BOTH - so both branches fired and the wrong labelling was invisible.
# A raygen shader declares only RayTracingKHR, which is where it would have shown.
CAP_RAY_QUERY = 4472
CAP_RAY_TRACING = 4479

# Every stage this can build, in pipeline order: the request field it arrives in, its
# Vulkan stage bit, and what to call it in a message. One table rather than a named local
# per stage, because adding one used to mean editing five places that had to agree.
PIPELINE_STAGES = [
    ("ts", VK_SHADER_STAGE_TASK_BIT_EXT, "amplification"),
    ("ms", VK_SHADER_STAGE_MESH_BIT_EXT, "mesh"),
    ("vs", VK_SHADER_STAGE_VERTEX_BIT, "vertex"),
    ("hs", VK_SHADER_STAGE_TESSELLATION_CONTROL_BIT, "hull"),
    ("ds", VK_SHADER_STAGE_TESSELLATION_EVALUATION_BIT, "domain"),
    ("gs", VK_SHADER_STAGE_GEOMETRY_BIT, "geometry"),
    ("fs", VK_SHADER_STAGE_FRAGMENT_BIT, "fragment"),
]

# The raytracing stages, in the order their groups are built. Separate from the table
# above because they never appear in the same pipeline as any of it - a raytracing
# pipeline has no graphics stages and no render state at all.
RT_STAGES = [
    ("rgen", VK_SHADER_STAGE_RAYGEN_BIT_KHR, "raygeneration"),
    ("miss", VK_SHADER_STAGE_MISS_BIT_KHR, "miss"),
    ("call", VK_SHADER_STAGE_CALLABLE_BIT_KHR, "callable"),
    ("chit", VK_SHADER_STAGE_CLOSEST_HIT_BIT_KHR, "closesthit"),
    ("ahit", VK_SHADER_STAGE_ANY_HIT_BIT_KHR, "anyhit"),
    ("sect", VK_SHADER_STAGE_INTERSECTION_BIT_KHR, "intersection"),
]


# ---------------------------------------------------------------- interpreter gate

def refuse_interpreter():
    """Why this interpreter cannot be used, or None.

    Both refusals are about the same contract: a native library loaded into *this* process
    writes files that *another* process reads back. Anything that redirects either the pointer
    width or the filesystem breaks it in a way that looks like a shader problem.
    """
    if C.sizeof(C.c_void_p) != 8:
        return ("this is a 32-bit Python (%d-bit pointers). Vulkan's dispatchable handles and "
                "every struct offset here assume 64 bits. Install a 64-bit Python 3, or set "
                "nvIsaExtractor.compile.pythonPath to one." % (C.sizeof(C.c_void_p) * 8))

    # A Microsoft Store Python runs under packaged-app filesystem redirection, which retargets
    # writes under %LOCALAPPDATA% - including the shader cache directory this whole feature
    # reads back from. `python` on a stock Windows resolves to the Store alias, so this is the
    # common case rather than an exotic one.
    for candidate in (sys.executable or "", getattr(sys, "_base_executable", "") or ""):
        if "windowsapps" in candidate.replace("\\", "/").lower():
            return ("this is a Microsoft Store Python (%s). Its filesystem redirection moves "
                    "the shader cache this feature reads back, so the compile would appear to "
                    "produce nothing. Install Python 3 from python.org, or set "
                    "nvIsaExtractor.compile.pythonPath to a real interpreter." % candidate)
    return None


# ---------------------------------------------------------------- loader

def load_loader(explicit=None):
    names = [explicit] if explicit else []
    if sys.platform == "win32":
        names += ["vulkan-1.dll"]
    elif sys.platform == "darwin":
        names += ["libvulkan.1.dylib", "libMoltenVK.dylib"]
    else:
        names += ["libvulkan.so.1", "libvulkan.so"]
    tried = []
    for n in names:
        if not n or n in tried:
            continue
        tried.append(n)
        try:
            return C.CDLL(n), n, tried
        except OSError:
            continue
    return None, None, tried


def bind(lib):
    """Declare argtypes and restype on every entry point, without exception.

    ctypes' default restype is c_int, so anything returning a pointer is truncated to 32 bits
    and the failure is a wild pointer rather than an error. Nothing here is left to the default.
    """
    sig = {
        "vkCreateInstance": ([VOID, VOID, VOID], i32),
        "vkDestroyInstance": ([Handle, VOID], None),
        "vkEnumerateInstanceLayerProperties": ([VOID, VOID], i32),
        # restype MUST be c_void_p. ctypes defaults to c_int, which truncates a 64-bit
        # function pointer to 32 bits - and the result is a wild call rather than an error.
        "vkGetInstanceProcAddr": ([Handle, C.c_char_p], VOID),
        "vkEnumeratePhysicalDevices": ([Handle, VOID, VOID], i32),
        "vkGetPhysicalDeviceProperties": ([Handle, VOID], None),
        "vkGetPhysicalDeviceQueueFamilyProperties": ([Handle, VOID, VOID], None),
        "vkCreateDevice": ([Handle, VOID, VOID, VOID], i32),
        "vkDestroyDevice": ([Handle, VOID], None),
        "vkCreateShaderModule": ([Handle, VOID, VOID, VOID], i32),
        "vkDestroyShaderModule": ([Handle, NonDisp, VOID], None),
        "vkCreateDescriptorSetLayout": ([Handle, VOID, VOID, VOID], i32),
        "vkDestroyDescriptorSetLayout": ([Handle, NonDisp, VOID], None),
        "vkCreatePipelineLayout": ([Handle, VOID, VOID, VOID], i32),
        "vkDestroyPipelineLayout": ([Handle, NonDisp, VOID], None),
        "vkCreateGraphicsPipelines": ([Handle, NonDisp, u32, VOID, VOID, VOID], i32),
        "vkGetDeviceProcAddr": ([Handle, C.c_char_p], VOID),
        "vkDestroyPipeline": ([Handle, NonDisp, VOID], None),
    }
    fns = {}
    for name, (argtypes, restype) in sig.items():
        fn = getattr(lib, name)
        fn.argtypes = argtypes
        fn.restype = restype
        fns[name] = fn
    return fns


def validation_available(vk):
    """Whether VK_LAYER_KHRONOS_validation is installed.

    It ships with the Vulkan SDK, not with the display driver, so a machine that can compile
    shaders perfectly well may not have it. Callers skip rather than fail on a false here.
    """
    n = u32()
    vk["vkEnumerateInstanceLayerProperties"](C.byref(n), None)
    if not n.value:
        return False
    layers = (VkLayerProperties * n.value)()
    vk["vkEnumerateInstanceLayerProperties"](C.byref(n), C.byref(layers))
    return any(layers[k].layerName == VALIDATION_LAYER for k in range(n.value))


class Validation(object):
    """Counts what the validation layer says, through a debug messenger.

    Not by reading the layer's stderr. The layer's default output format is its own business
    and a grep for it is a test that breaks when a version changes; a messenger is the
    mechanism that exists for asking. It also catches what stderr alone would not tell you
    apart - the layer reports some faults and still lets the call succeed, which is how a
    disabled `dynamicRendering` produced correct microcode from an invalid device for as long
    as nobody looked.
    """

    def __init__(self):
        self.errors = []
        self.warnings = []
        self.messenger = None
        self._destroy = None
        # The trampoline is kept on the instance deliberately. A ctypes callback that is only
        # referenced by the Vulkan struct is collected as soon as the local goes out of scope,
        # and the driver then calls freed memory - a crash with no connection to its cause.
        self._callback = DEBUG_CALLBACK(self._on_message)

    def _on_message(self, severity, _types, data, _user):
        # Nothing here may raise. An exception inside a ctypes callback is printed and
        # swallowed, leaving the driver to carry on with a return value nobody chose.
        try:
            text = ""
            if data:
                raw = data.contents.pMessage
                text = raw.decode("utf-8", "replace") if raw else ""
            if severity & SEVERITY_ERROR:
                self.errors.append(text)
            elif severity & SEVERITY_WARNING:
                self.warnings.append(text)
        except Exception:                                        # noqa: BLE001
            self.errors.append("<a validation message could not be read>")
        return VK_FALSE                                          # never abort the call

    def attach(self, vk, instance, note):
        create = vk["vkGetInstanceProcAddr"](instance, b"vkCreateDebugUtilsMessengerEXT")
        destroy = vk["vkGetInstanceProcAddr"](instance, b"vkDestroyDebugUtilsMessengerEXT")
        if not create or not destroy:
            note("the debug messenger is not available; validation was NOT checked")
            return False
        create_fn = C.CFUNCTYPE(i32, Handle, VOID, VOID, VOID)(create)
        self._destroy = (C.CFUNCTYPE(None, Handle, NonDisp, VOID)(destroy), vk, instance)

        info = VkDebugUtilsMessengerCreateInfoEXT(
            sType=ST["DEBUG_UTILS_MESSENGER_CREATE_INFO_EXT"],
            messageSeverity=SEVERITY_ERROR | SEVERITY_WARNING,
            messageType=MESSAGE_TYPE_ALL, pfnUserCallback=self._callback)
        handle = NonDisp()
        rc = create_fn(instance, C.byref(info), None, C.byref(handle))
        if rc != VK_SUCCESS:
            note("the debug messenger could not be created (VkResult %d)" % rc)
            return False
        self.messenger = handle.value
        self._info = info                                        # keep the struct alive too
        return True

    def detach(self):
        if self.messenger and self._destroy:
            destroy_fn, _vk, instance = self._destroy
            destroy_fn(instance, self.messenger, None)
            self.messenger = None


def read_spirv(path):
    with open(path, "rb") as h:
        blob = h.read()
    if not blob or len(blob) % 4:
        raise ValueError("%s is %d bytes, not a whole number of SPIR-V words"
                         % (path, len(blob)))
    return blob


# ---------------------------------------------------------------- the pipeline

class Poke(object):
    """One pipeline creation, with teardown that happens on every path.

    Teardown is not tidiness. The driver flushes what it compiled to its shader disk cache as
    the device is destroyed, and that cache file is the entire output of this program - so a
    path that returns without destroying the device produces nothing to carve, and the failure
    looks like "the shader has no instructions" rather than "the run was abandoned".
    """

    def __init__(self, vk, note):
        self.vk = vk
        self.note = note
        self.validation = None
        self.instance = None
        self.device = None
        self.modules = []
        self.set_layouts = []
        self.pipeline_layout = None
        self.pipeline = None
        self.keep = []            # anything a Vulkan struct points at, kept alive until teardown

    def destroy(self):
        vk, device = self.vk, self.device
        # The messenger is detached LAST, just before the instance it belongs to, because it
        # must outlive everything it might report on. It used to go first, which meant the
        # layer had nowhere to deliver anything raised while the pipeline, the layouts, the
        # modules or the device were being destroyed - and `main` says, correctly, that it
        # reads the messages after teardown so those are counted too. They were not: detaching
        # first closed the window that sentence describes.
        if device is not None:
            if self.pipeline:
                vk["vkDestroyPipeline"](device, self.pipeline, None)
            if self.pipeline_layout:
                vk["vkDestroyPipelineLayout"](device, self.pipeline_layout, None)
            for h in self.set_layouts:
                vk["vkDestroyDescriptorSetLayout"](device, h, None)
            for h in self.modules:
                vk["vkDestroyShaderModule"](device, h, None)
            vk["vkDestroyDevice"](device, None)
        if self.validation:
            self.validation.detach()
        if self.instance is not None:
            vk["vkDestroyInstance"](self.instance, None)

    # -- pointers ---------------------------------------------------------
    def ptr(self, obj):
        """A pointer field's value, with the pointee kept alive.

        `C.pointer(x)` alone is not enough when x is a temporary: the object it points at can
        be collected while the struct still holds the address, and the driver then reads freed
        memory - silently, and usually correctly, until it does not.
        """
        self.keep.append(obj)
        return C.pointer(obj)

    def build(self, request):
        vk = self.vk
        state = request.get("state") or {}
        fmt_name = state.get("format", "r8g8b8a8_unorm")
        depth_name = state.get("depth", "none")
        samples = int(state.get("samples", 1))
        if fmt_name not in COLOUR:
            return EXIT_UNUSABLE, "unknown colour format %r (have %s)" % (
                fmt_name, ", ".join(sorted(COLOUR)))
        if depth_name not in DEPTH:
            return EXIT_UNUSABLE, "unknown depth format %r (have %s)" % (
                depth_name, ", ".join(sorted(DEPTH)))
        colour, depth = COLOUR[fmt_name], DEPTH[depth_name]

        # One pass over the stage table instead of a named local per stage. Adding a stage used
        # to mean editing five places that had to agree - the paths, the reads, the modules,
        # the stage array and the feature bits - and mesh would have made a sixth copy of each.
        try:
            code = {}
            for slot, _bit, _name in PIPELINE_STAGES + RT_STAGES:
                path_ = request.get(slot)
                if path_:
                    code[slot] = read_spirv(path_)
        except (OSError, ValueError) as e:
            return EXIT_UNUSABLE, str(e)

        # A mesh pipeline has no vertex stage at all - the mesh shader IS the front of it - so
        # the requirement is one or the other rather than a vertex shader always.
        # What the modules say they need. The request may state it, and where it does not
        # the SPIR-V is read - a capability is not something to guess at either way.
        caps = set(request.get("capabilities") or [])
        if not caps:
            try:
                import spirv_reflect
                for blob in code.values():
                    caps.update(spirv_reflect.Module(blob).capabilities)
            except Exception:                                     # noqa: BLE001
                self.note("the declared capabilities could not be read; only the base "
                          "feature set is enabled")

        # Which kind of pipeline this is. A raytracing pipeline shares the instance, the
        # device, the modules and the descriptor layout with a graphics one, and nothing
        # else: no render state, a different creation call, and groups in place of a fixed
        # stage order.
        rt_pipeline = any(slot in code for slot, _b, _n in RT_STAGES)
        if rt_pipeline and any(slot in code for slot, _b, _n in PIPELINE_STAGES):
            return EXIT_UNUSABLE, (
                "this request mixes raytracing and graphics stages. They are different "
                "kinds of pipeline and cannot be created together.")
        if rt_pipeline and "rgen" not in code:
            return EXIT_UNUSABLE, (
                "a raytracing pipeline must contain a raygeneration shader - every other "
                "raytracing stage is reached from one.")

        mesh_pipeline = "ms" in code or "ts" in code
        if not rt_pipeline and not mesh_pipeline and "vs" not in code:
            return EXIT_UNUSABLE, (
                "the request names no vertex shader, and no mesh shader either. A pipeline "
                "needs one front stage or the other.")
        if not rt_pipeline and "ts" in code and "ms" not in code:
            return EXIT_UNUSABLE, (
                "an amplification shader exists only to dispatch a mesh shader, and this "
                "request names none.")
        no_fs = "fs" not in code

        topology_name = state.get("topology",
                                  "patch_list" if "hs" in code or "ds" in code
                                  else "triangle_list")
        # How many vertices make one patch. There is no sensible default: it is the size
        # of the hull shader's input array, and a wrong one is a pipeline the driver
        # accepts while tessellating something nobody wrote.
        patch_points = int(state.get("patchControlPoints", 0) or 0)
        if topology_name not in TOPOLOGY:
            return EXIT_UNUSABLE, "unknown topology %r (have %s)" % (
                topology_name, ", ".join(sorted(TOPOLOGY)))

        # -- instance ----------------------------------------------------
        layers = [l.encode("utf-8") for l in (request.get("layers") or [])]
        extensions = []
        # `validate` is the whole feature in one flag: turn the layer on, turn the messenger
        # on, and make what it says fatal. Asking for it on a machine without the layer is a
        # refusal rather than a silent pass - a validation run that validated nothing and
        # reported success is the worst of the three outcomes.
        if request.get("validate"):
            if not validation_available(vk):
                return EXIT_UNUSABLE, (
                    "validation was asked for, but VK_LAYER_KHRONOS_validation is not "
                    "installed. It ships with the Vulkan SDK rather than with the display "
                    "driver, so a machine that compiles shaders perfectly well may not have it.")
            if VALIDATION_LAYER not in layers:
                layers.append(VALIDATION_LAYER)
            extensions.append(DEBUG_UTILS_EXTENSION)

        layer_array = (C.c_char_p * len(layers))(*layers) if layers else None
        ext_array = (C.c_char_p * len(extensions))(*extensions) if extensions else None
        self.keep.extend([layer_array, ext_array])
        app = VkApplicationInfo(sType=ST["APPLICATION_INFO"],
                                pApplicationName=b"nv-isa-extractor",
                                apiVersion=api_version(1, 3))
        ici = VkInstanceCreateInfo(
            sType=ST["INSTANCE_CREATE_INFO"], pApplicationInfo=self.ptr(app),
            enabledLayerCount=len(layers),
            ppEnabledLayerNames=C.cast(layer_array, VOID) if layers else None,
            enabledExtensionCount=len(extensions),
            ppEnabledExtensionNames=C.cast(ext_array, VOID) if extensions else None)
        instance = Handle()
        r = vk["vkCreateInstance"](C.byref(ici), None, C.byref(instance))
        if r != VK_SUCCESS:
            if r == VK_ERROR_INCOMPATIBLE_DRIVER:
                return EXIT_UNUSABLE, (
                    "vkCreateInstance: VK_ERROR_INCOMPATIBLE_DRIVER (-9). No Vulkan driver is "
                    "registered here. A datacenter or headless driver installs no Vulkan ICD, "
                    "and a Remote Desktop session may enumerate none.")
            return EXIT_UNUSABLE, "vkCreateInstance failed (VkResult %d)" % r
        self.instance = instance

        # Attached immediately, so device creation is inside the window it watches. The
        # `dynamicRendering` fault this exists to catch happened at vkCreateDevice.
        if request.get("validate"):
            self.validation = Validation()
            if not self.validation.attach(vk, instance, self.note):
                return EXIT_UNUSABLE, "the debug messenger could not be attached"

        # -- device ------------------------------------------------------
        n = u32()
        vk["vkEnumeratePhysicalDevices"](instance, C.byref(n), None)
        devices = (Handle * max(n.value, 1))()
        vk["vkEnumeratePhysicalDevices"](instance, C.byref(n), C.byref(devices))

        gpu, props = None, None
        seen = []
        for k in range(n.value):
            p = VkPhysicalDeviceProperties()
            vk["vkGetPhysicalDeviceProperties"](Handle(devices[k]), C.byref(p))
            seen.append("%s (vendor 0x%04X)" % (p.deviceName.decode("utf-8", "replace"),
                                                p.vendorID))
            if p.vendorID == 0x10DE and gpu is None:
                gpu, props = Handle(devices[k]), p
        self.note("devices: %s" % ("; ".join(seen) if seen else "none"))
        if gpu is None:
            return EXIT_UNUSABLE, (
                "no NVIDIA device is visible to Vulkan (%d device(s): %s). SASS is NVIDIA "
                "machine code, so there is nothing to disassemble from another vendor's driver."
                % (n.value, ", ".join(seen) or "none"))

        vk["vkGetPhysicalDeviceQueueFamilyProperties"](gpu, C.byref(n), None)
        fams = (VkQueueFamilyProperties * max(n.value, 1))()
        vk["vkGetPhysicalDeviceQueueFamilyProperties"](gpu, C.byref(n), C.byref(fams))
        graphics = next((k for k in range(n.value)
                         if fams[k].queueFlags & VK_QUEUE_GRAPHICS_BIT), None)
        if graphics is None:
            return EXIT_UNUSABLE, "the NVIDIA device exposes no graphics queue family"

        priority = f32(1.0)
        qci = VkDeviceQueueCreateInfo(sType=ST["DEVICE_QUEUE_CREATE_INFO"],
                                      queueFamilyIndex=graphics, queueCount=1,
                                      pQueuePriorities=self.ptr(priority))
        f13 = VkPhysicalDeviceVulkan13Features(
            sType=ST["PHYSICAL_DEVICE_VULKAN_1_3_FEATURES"], dynamicRendering=VK_TRUE)
        f11 = VkPhysicalDeviceVulkan11Features(
            sType=ST["PHYSICAL_DEVICE_VULKAN_1_1_FEATURES"],
            pNext=C.cast(self.ptr(f13), VOID), shaderDrawParameters=VK_TRUE)
        head = self.ptr(f11)
        device_extensions = []

        # Ray query needs no pipeline of its own - it lives inside an ordinary shader - so it
        # is nothing but a chain of features and extensions. The acceleration structure it
        # traverses is a descriptor like any other, which is why nothing else had to change.
        if CAP_RAY_QUERY in caps or CAP_RAY_TRACING in caps:
            device_extensions += [b"VK_KHR_acceleration_structure",
                                  b"VK_KHR_deferred_host_operations"]
            faddr = VkPhysicalDeviceBufferDeviceAddressFeatures(
                sType=ST["PHYSICAL_DEVICE_BUFFER_DEVICE_ADDRESS_FEATURES"],
                pNext=C.cast(head, VOID), bufferDeviceAddress=VK_TRUE)
            faccel = VkPhysicalDeviceAccelerationStructureFeaturesKHR(
                sType=ST["PHYSICAL_DEVICE_ACCELERATION_STRUCTURE_FEATURES_KHR"],
                pNext=C.cast(self.ptr(faddr), VOID), accelerationStructure=VK_TRUE)
            head = self.ptr(faccel)
            if CAP_RAY_QUERY in caps:
                device_extensions.append(b"VK_KHR_ray_query")
                fquery = VkPhysicalDeviceRayQueryFeaturesKHR(
                    sType=ST["PHYSICAL_DEVICE_RAY_QUERY_FEATURES_KHR"],
                    pNext=C.cast(head, VOID), rayQuery=VK_TRUE)
                head = self.ptr(fquery)
            if CAP_RAY_TRACING in caps:
                # Slang declares RayTracingKHR even for inline ray tracing, so this follows the
                # module rather than the feature being used.
                device_extensions.append(b"VK_KHR_ray_tracing_pipeline")
                fpipe = VkPhysicalDeviceRayTracingPipelineFeaturesKHR(
                    sType=ST["PHYSICAL_DEVICE_RAY_TRACING_PIPELINE_FEATURES_KHR"],
                    pNext=C.cast(head, VOID), rayTracingPipeline=VK_TRUE)
                head = self.ptr(fpipe)
            self.note("ray tracing       enabled from the modules' declared capabilities")
        if mesh_pipeline:
            # Mesh shading is an extension: the feature struct alone is not enough, the device
            # extension has to be enabled too or the stage bits are not even recognised.
            device_extensions.append(MESH_EXTENSION)
            fmesh = VkPhysicalDeviceMeshShaderFeaturesEXT(
                sType=ST["PHYSICAL_DEVICE_MESH_SHADER_FEATURES_EXT"],
                pNext=C.cast(head, VOID),
                meshShader=VK_TRUE, taskShader=VK_TRUE if "ts" in code else VK_FALSE)
            head = self.ptr(fmesh)
        # A geometry or tessellation stage is a device feature, not just another entry in the
        # stage array: a pipeline naming one on a device where it was not enabled is rejected.
        f2 = VkPhysicalDeviceFeatures2(
            sType=ST["PHYSICAL_DEVICE_FEATURES_2"], pNext=C.cast(head, VOID),
            features=VkPhysicalDeviceFeatures(
                geometryShader=VK_TRUE if "gs" in code else VK_FALSE,
                tessellationShader=VK_TRUE if ("hs" in code or "ds" in code) else VK_FALSE))
        dext_array = ((C.c_char_p * len(device_extensions))(*device_extensions)
                      if device_extensions else None)
        self.keep.append(dext_array)
        dci = VkDeviceCreateInfo(
            sType=ST["DEVICE_CREATE_INFO"], pNext=C.cast(self.ptr(f2), VOID),
            queueCreateInfoCount=1, pQueueCreateInfos=self.ptr(qci),
            enabledExtensionCount=len(device_extensions),
            ppEnabledExtensionNames=C.cast(dext_array, VOID) if device_extensions else None)
        device = Handle()
        r = vk["vkCreateDevice"](gpu, C.byref(dci), None, C.byref(device))
        if r != VK_SUCCESS:
            return EXIT_UNUSABLE, "vkCreateDevice failed (VkResult %d)" % r
        self.device = device

        # -- modules -----------------------------------------------------
        def module(blob, what):
            buf = C.create_string_buffer(blob, len(blob))
            self.keep.append(buf)
            smci = VkShaderModuleCreateInfo(sType=ST["SHADER_MODULE_CREATE_INFO"],
                                            codeSize=len(blob), pCode=C.cast(buf, VOID))
            h = NonDisp()
            rc = vk["vkCreateShaderModule"](device, C.byref(smci), None, C.byref(h))
            if rc != VK_SUCCESS:
                return None, "vkCreateShaderModule(%s) failed (VkResult %d)" % (what, rc)
            self.modules.append(h.value)
            return h.value, None

        handles = {}
        for slot, _bit, name in PIPELINE_STAGES + RT_STAGES:
            if slot not in code:
                continue
            handle, err = module(code[slot], name)
            if err:
                return EXIT_REFUSED, err
            handles[slot] = handle

        # -- descriptor layout -------------------------------------------
        # Grouped by set, because a VkPipelineLayout takes one VkDescriptorSetLayout per set
        # and the sets must be contiguous from 0 - a gap is not expressible.
        # Which stages a descriptor is visible to. The union of what this pipeline holds,
        # not a constant: VK_SHADER_STAGE_ALL_GRAPHICS does not include the raytracing
        # stages, so a raygeneration shader reading its own acceleration structure was an
        # invalid layout - built anyway, and caught only by the layer. Narrower than
        # VK_SHADER_STAGE_ALL for the same reason the descriptor layout is reflected
        # rather than over-provisioned.
        stage_mask = 0
        for slot, bit, _name in PIPELINE_STAGES + RT_STAGES:
            if slot in code:
                stage_mask |= bit

        spec = request.get("layout") or {}
        by_set = {}
        for entry in spec.get("bindings") or []:
            s, b, t, count = (list(entry) + [1])[:4]
            by_set.setdefault(int(s), []).append((int(b), int(t), int(count)))
        if by_set and sorted(by_set) != list(range(max(by_set) + 1)):
            return EXIT_UNUSABLE, (
                "the descriptor sets are %s, which is not contiguous from 0; an empty set "
                "cannot be skipped in a pipeline layout" % sorted(by_set))

        set_handles = (NonDisp * max(len(by_set), 1))()
        for index in sorted(by_set):
            entries = sorted(by_set[index])
            arr = (VkDescriptorSetLayoutBinding * len(entries))()
            for k, (b, t, count) in enumerate(entries):
                arr[k].binding = b
                arr[k].descriptorType = t
                arr[k].descriptorCount = count
                arr[k].stageFlags = stage_mask
            self.keep.append(arr)
            dslci = VkDescriptorSetLayoutCreateInfo(
                sType=ST["DESCRIPTOR_SET_LAYOUT_CREATE_INFO"],
                bindingCount=len(entries),
                pBindings=C.cast(arr, C.POINTER(VkDescriptorSetLayoutBinding)))
            h = NonDisp()
            r = vk["vkCreateDescriptorSetLayout"](device, C.byref(dslci), None, C.byref(h))
            if r != VK_SUCCESS:
                return EXIT_REFUSED, "vkCreateDescriptorSetLayout(set %d) failed (VkResult %d)" \
                    % (index, r)
            self.set_layouts.append(h.value)
            set_handles[index] = h.value

        push_bytes = int(spec.get("pushBytes") or 0)
        push = VkPushConstantRange(offset=0,
                                   size=push_bytes)
        push.stageFlags = stage_mask
        self.keep.append(set_handles)
        plci = VkPipelineLayoutCreateInfo(
            sType=ST["PIPELINE_LAYOUT_CREATE_INFO"],
            setLayoutCount=len(by_set),
            pSetLayouts=C.cast(set_handles, C.POINTER(NonDisp)) if by_set else None,
            pushConstantRangeCount=1 if push_bytes else 0,
            pPushConstantRanges=self.ptr(push) if push_bytes else None)
        lay = NonDisp()
        r = vk["vkCreatePipelineLayout"](device, C.byref(plci), None, C.byref(lay))
        if r != VK_SUCCESS:
            return EXIT_REFUSED, "vkCreatePipelineLayout failed (VkResult %d)" % r
        self.pipeline_layout = lay.value
        self.note("layout: %d set(s), %d binding(s), %d push byte(s)"
                  % (len(by_set), sum(len(v) for v in by_set.values()), push_bytes))

        # Said before the roads part. It used to be printed further down, past the point
        # where a raytracing pipeline returns, so the one lineage whose output is specific to
        # the local GPU produced listings that never named it.
        self.note("device            %s" % props.deviceName.decode("utf-8", "replace"))

        if rt_pipeline:
            return self.raytracing_pipeline(handles, code)

        # -- pipeline ----------------------------------------------------
        # Straight off the table, in pipeline order. Vulkan takes them in any order; this one
        # is what a reader expects.
        wanted = [(bit, handles[slot]) for slot, bit, _n in PIPELINE_STAGES if slot in handles]
        stages = (VkPipelineShaderStageCreateInfo * len(wanted))()
        for k, (bit, handle) in enumerate(wanted):
            stages[k].sType = ST["PIPELINE_SHADER_STAGE_CREATE_INFO"]
            stages[k].stage = bit
            stages[k].module = handle
            stages[k].pName = b"main"
        self.keep.append(stages)

        vi = VkPipelineVertexInputStateCreateInfo(
            sType=ST["PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO"])
        ia = VkPipelineInputAssemblyStateCreateInfo(
            sType=ST["PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO"],
            topology=TOPOLOGY[topology_name])
        vp = VkPipelineViewportStateCreateInfo(sType=ST["PIPELINE_VIEWPORT_STATE_CREATE_INFO"],
                                               viewportCount=1, scissorCount=1)
        tess = None
        if "hs" in handles or "ds" in handles:
            if patch_points < 1:
                return EXIT_UNUSABLE, (
                    "a tessellation pipeline needs state.patchControlPoints - the number of "
                    "vertices in one patch, which is the size of the hull shader's input "
                    "array. There is no default worth guessing.")
            tess = VkPipelineTessellationStateCreateInfo(
                sType=ST["PIPELINE_TESSELLATION_STATE_CREATE_INFO"],
                patchControlPoints=patch_points)
        rs = VkPipelineRasterizationStateCreateInfo(
            sType=ST["PIPELINE_RASTERIZATION_STATE_CREATE_INFO"],
            polygonMode=VK_POLYGON_MODE_FILL, cullMode=VK_CULL_MODE_NONE,
            frontFace=VK_FRONT_FACE_COUNTER_CLOCKWISE, lineWidth=1.0,
            rasterizerDiscardEnable=VK_TRUE if no_fs else VK_FALSE)
        ms = VkPipelineMultisampleStateCreateInfo(
            sType=ST["PIPELINE_MULTISAMPLE_STATE_CREATE_INFO"], rasterizationSamples=samples)
        ds = VkPipelineDepthStencilStateCreateInfo(
            sType=ST["PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO"],
            depthTestEnable=VK_TRUE if depth else VK_FALSE,
            depthWriteEnable=VK_TRUE if depth else VK_FALSE,
            depthCompareOp=VK_COMPARE_OP_LESS)
        # The write mask must be non-zero. A masked-off attachment makes the fragment shader's
        # output dead, and the whole varying chain back through the vertex shader dies with it.
        blend = VkPipelineColorBlendAttachmentState(blendEnable=VK_FALSE,
                                                    colorWriteMask=VK_COLOR_COMPONENT_RGBA)
        cb = VkPipelineColorBlendStateCreateInfo(
            sType=ST["PIPELINE_COLOR_BLEND_STATE_CREATE_INFO"],
            attachmentCount=0 if no_fs else 1,
            pAttachments=None if no_fs else self.ptr(blend))
        dynamics = (VkEnum * 2)(VK_DYNAMIC_STATE_VIEWPORT, VK_DYNAMIC_STATE_SCISSOR)
        dyn = VkPipelineDynamicStateCreateInfo(
            sType=ST["PIPELINE_DYNAMIC_STATE_CREATE_INFO"],
            dynamicStateCount=2, pDynamicStates=C.cast(dynamics, C.POINTER(VkEnum)))
        self.keep.append(dynamics)

        colour_fmt = VkEnum(colour)
        rendering = VkPipelineRenderingCreateInfo(
            sType=ST["PIPELINE_RENDERING_CREATE_INFO"],
            colorAttachmentCount=0 if no_fs else 1,
            pColorAttachmentFormats=None if no_fs else self.ptr(colour_fmt),
            depthAttachmentFormat=depth,
            stencilAttachmentFormat=depth if depth in (DEPTH["d24s8"], DEPTH["d32s8"]) else 0)

        gpci = VkGraphicsPipelineCreateInfo(
            sType=ST["GRAPHICS_PIPELINE_CREATE_INFO"],
            pNext=C.cast(self.ptr(rendering), VOID),
            stageCount=len(wanted),
            pStages=C.cast(stages, C.POINTER(VkPipelineShaderStageCreateInfo)),
            # A mesh pipeline has no vertex input and no input assembler: the mesh shader
            # produces primitives directly, so both are ignored and passing them is noise.
            pVertexInputState=None if mesh_pipeline else self.ptr(vi),
            pInputAssemblyState=None if mesh_pipeline else self.ptr(ia),
            pTessellationState=C.cast(self.ptr(tess), VOID) if tess else None,
            pViewportState=self.ptr(vp), pRasterizationState=self.ptr(rs),
            pMultisampleState=self.ptr(ms), pDepthStencilState=self.ptr(ds),
            pColorBlendState=self.ptr(cb), pDynamicState=self.ptr(dyn),
            layout=self.pipeline_layout)

        pipeline = NonDisp()
        r = vk["vkCreateGraphicsPipelines"](device, VK_NULL_HANDLE, 1, C.byref(gpci), None,
                                            C.byref(pipeline))
        if r != VK_SUCCESS:
            return EXIT_REFUSED, "vkCreateGraphicsPipelines failed (VkResult %d)" % r
        self.pipeline = pipeline.value

        v = props.apiVersion
        self.note("api               %u.%u.%u" % (v >> 22, (v >> 12) & 0x3FF, v & 0xFFF))
        self.note("colour format     %s (%d)" % (fmt_name, colour))
        self.note("depth format      %s (%d)" % (depth_name, depth))
        self.note("samples           %u" % samples)
        if not mesh_pipeline:
            self.note("topology          %s%s" % (
                topology_name, " (%d control points)" % patch_points if tess else ""))
        self.note("stages            %s" % " + ".join(
            name for slot, _bit, name in PIPELINE_STAGES if slot in handles))
        return EXIT_OK, None


def raytracing_pipeline(self, handles, code):
    """Create the raytracing pipeline, once the device, modules and layout exist.

    A raytracing pipeline is not a graphics pipeline with different stages in it. There is no
    fixed order for the driver to infer, so the shaders are grouped explicitly: each group
    names either one general shader - a raygeneration, miss or callable - or the hit shaders
    that answer for one kind of geometry. Nothing else about a graphics pipeline applies: no
    vertex input, no rasterizer, no attachments, no dynamic rendering.

    The groups here are the smallest set that makes the shaders reachable, which is all that is
    needed to make the driver compile them. A real application's grouping decides which shader
    answers for which instance, and that is a property of its scene rather than of its code.
    """
    vk = self.vk
    # An extension entry point: not exported by the loader, so it comes through
    # vkGetDeviceProcAddr with an explicit restype - the default int would truncate it.
    address = vk["vkGetDeviceProcAddr"](self.device, b"vkCreateRayTracingPipelinesKHR")
    if not address:
        return EXIT_UNUSABLE, (
            "vkCreateRayTracingPipelinesKHR is not available on this device, so a raytracing "
            "pipeline cannot be created. Inline ray tracing needs no such call and still works.")
    create = C.CFUNCTYPE(i32, Handle, NonDisp, NonDisp, u32, VOID, VOID, VOID)(address)

    stages = (VkPipelineShaderStageCreateInfo * len(handles))()
    index = {}
    at = 0
    for slot, bit, _name in RT_STAGES:
        if slot not in handles:
            continue
        stages[at].sType = ST["PIPELINE_SHADER_STAGE_CREATE_INFO"]
        stages[at].stage = bit
        stages[at].module = handles[slot]
        stages[at].pName = b"main"
        index[slot] = at
        at += 1
    self.keep.append(stages)

    groups = []
    # One general group per raygeneration, miss and callable shader.
    for slot in ("rgen", "miss", "call"):
        if slot in index:
            groups.append((GROUP_GENERAL, index[slot], VK_SHADER_UNUSED_KHR,
                           VK_SHADER_UNUSED_KHR, VK_SHADER_UNUSED_KHR))
    # And one hit group for the hit shaders, procedural when an intersection shader decides
    # the hit and triangles when the fixed-function intersector does.
    if any(slot in index for slot in ("chit", "ahit", "sect")):
        groups.append((
            GROUP_PROCEDURAL_HIT if "sect" in index else GROUP_TRIANGLES_HIT,
            VK_SHADER_UNUSED_KHR,
            index.get("chit", VK_SHADER_UNUSED_KHR),
            index.get("ahit", VK_SHADER_UNUSED_KHR),
            index.get("sect", VK_SHADER_UNUSED_KHR)))

    array = (VkRayTracingShaderGroupCreateInfoKHR * len(groups))()
    for k, (kind, general, chit, ahit, sect) in enumerate(groups):
        array[k].sType = ST["RAY_TRACING_SHADER_GROUP_CREATE_INFO_KHR"]
        array[k].type = kind
        array[k].generalShader = general
        array[k].closestHitShader = chit
        array[k].anyHitShader = ahit
        array[k].intersectionShader = sect
    self.keep.append(array)

    rtci = VkRayTracingPipelineCreateInfoKHR(
        sType=ST["RAY_TRACING_PIPELINE_CREATE_INFO_KHR"],
        stageCount=at,
        pStages=C.cast(stages, C.POINTER(VkPipelineShaderStageCreateInfo)),
        groupCount=len(groups),
        pGroups=C.cast(array, C.POINTER(VkRayTracingShaderGroupCreateInfoKHR)),
        # One bounce. Recursion depth is a promise to the driver about how deep TraceRay may
        # nest, and it is codegen-relevant - so it is stated rather than maximised.
        maxPipelineRayRecursionDepth=1,
        layout=self.pipeline_layout)

    pipeline = NonDisp()
    r = create(self.device, VK_NULL_HANDLE, VK_NULL_HANDLE, 1, C.byref(rtci), None,
               C.byref(pipeline))
    if r != VK_SUCCESS:
        return EXIT_REFUSED, "vkCreateRayTracingPipelinesKHR failed (VkResult %d)" % r
    self.pipeline = pipeline.value

    self.note("stages            %s" % " + ".join(
        name for slot, _bit, name in RT_STAGES if slot in index))
    self.note("groups            %d (%s)" % (
        len(groups), ", ".join("general" if g[0] == GROUP_GENERAL
                               else "procedural hit" if g[0] == GROUP_PROCEDURAL_HIT
                               else "triangles hit" for g in groups)))
    self.note("recursion depth   1")
    return EXIT_OK, None


Poke.raytracing_pipeline = raytracing_pipeline


def check_interface(request, note):
    """Refuse a producer/consumer pair whose interfaces do not match.

    The driver will not do this for us: measured on an RTX A4500, a mismatched pair violates
    VUID-RuntimeSpirv-OpEntryPoint-08743 and VUID-RuntimeSpirv-maintenance4-06817, and the
    driver still compiles it, still exits 0, and still yields byte-identical fragment code.
    Only the validation layer objects. A listing produced from such a pipeline would describe
    something undefined, so the check is done here rather than hoped for downstream.
    """
    if not request.get("fs") or not request.get("checkInterface", True):
        return None
    try:
        import spirv_reflect
    except ImportError:
        note("spirv_reflect is not importable; the stage interface was NOT checked")
        return None
    try:
        with open(request["vs"], "rb") as h:
            produced = spirv_reflect.Module(h.read()).interface(spirv_reflect.SC_OUTPUT)
        with open(request["fs"], "rb") as h:
            consumed = spirv_reflect.Module(h.read()).interface(spirv_reflect.SC_INPUT)
    except spirv_reflect.ReflectError as e:
        note("the stage interface could not be read (%s); it was NOT checked" % e)
        return None
    return spirv_reflect.interfaces_match(produced, consumed)


def check_topology(request, note):
    """Refuse a topology the geometry shader does not consume.

    The spec requires the input assembly topology to be compatible with the geometry shader's
    declared input primitive. Measured here: it is not enforced. A triangle-input shader behind
    a point list creates a pipeline, exits zero, and yields the same microcode - the same shape
    of silence as a mismatched varying interface. So the check is done here, where it can be a
    refusal, rather than left to a driver that will not object.
    """
    gs_path = request.get("gs")
    if not gs_path or not request.get("checkTopology", True):
        return None
    try:
        import spirv_reflect
        with open(gs_path, "rb") as h:
            name, wanted, _vertices = spirv_reflect.Module(h.read()).input_primitive()
    except ImportError:
        note("spirv_reflect is not importable; the topology was NOT checked")
        return None
    except spirv_reflect.ReflectError as e:
        note("the input primitive could not be read (%s); the topology was NOT checked" % e)
        return None

    given = (request.get("state") or {}).get("topology", "triangle_list")
    if given != wanted:
        return ("this geometry shader consumes %s, which needs a %s, but the pipeline was "
                "asked for a %s" % (name, wanted, given))
    return None


def probe(loader):
    lib, which, tried = load_loader(loader)
    if lib is None:
        sys.stderr.write("could not load the Vulkan loader. Looked for: %s\n"
                         "It ships with the display driver; the Vulkan SDK is not required.\n"
                         % ", ".join(tried))
        return EXIT_UNUSABLE
    vk = bind(lib)
    sys.stdout.write("loader            %s\n" % which)

    app = VkApplicationInfo(sType=ST["APPLICATION_INFO"], pApplicationName=b"nv-isa-extractor",
                            apiVersion=api_version(1, 3))
    ici = VkInstanceCreateInfo(sType=ST["INSTANCE_CREATE_INFO"], pApplicationInfo=C.pointer(app))
    instance = Handle()
    r = vk["vkCreateInstance"](C.byref(ici), None, C.byref(instance))
    if r != VK_SUCCESS:
        sys.stderr.write("vkCreateInstance failed (VkResult %d)%s\n"
                         % (r, " - no Vulkan ICD is registered" if r == VK_ERROR_INCOMPATIBLE_DRIVER else ""))
        return EXIT_UNUSABLE
    try:
        n = u32()
        vk["vkEnumeratePhysicalDevices"](instance, C.byref(n), None)
        devices = (Handle * max(n.value, 1))()
        vk["vkEnumeratePhysicalDevices"](instance, C.byref(n), C.byref(devices))
        nvidia = 0
        for k in range(n.value):
            p = VkPhysicalDeviceProperties()
            vk["vkGetPhysicalDeviceProperties"](Handle(devices[k]), C.byref(p))
            v = p.apiVersion
            sys.stdout.write("device            %s (vendor 0x%04X, api %u.%u.%u)\n"
                             % (p.deviceName.decode("utf-8", "replace"), p.vendorID,
                                v >> 22, (v >> 12) & 0x3FF, v & 0xFFF))
            if p.vendorID == 0x10DE:
                nvidia += 1
        if not nvidia:
            sys.stderr.write("no NVIDIA device is visible to Vulkan (%d device(s))\n" % n.value)
            return EXIT_UNUSABLE
    finally:
        vk["vkDestroyInstance"](instance, None)
    return EXIT_OK


def main(argv):
    faulthandler.enable()                 # so a SIGSEGV on Linux prints where it died

    if "--layout" in argv:
        json.dump(layout_report(), sys.stdout, indent=1, sort_keys=True)
        return EXIT_OK

    refusal = refuse_interpreter()
    if refusal:
        sys.stderr.write("%s\n" % refusal)
        return EXIT_INTERPRETER

    if "--probe" in argv:
        return probe(os.environ.get("VK_LOADER"))

    if len(argv) != 2:
        sys.stderr.write(__doc__)
        return EXIT_UNUSABLE
    with open(argv[1], "r", encoding="utf-8") as handle:
        request = json.load(handle)

    def note(line):
        sys.stdout.write("%s\n" % line)

    mismatch = check_interface(request, note)
    if mismatch:
        sys.stderr.write(
            "the producer and the fragment shader do not agree on their interface: %s.\n"
            "A pipeline built from them is undefined, and the driver would compile it anyway.\n"
            % mismatch)
        return EXIT_REFUSED

    wrong_topology = check_topology(request, note)
    if wrong_topology:
        sys.stderr.write(
            "%s.\nA pipeline built that way is invalid, and the driver would compile it "
            "anyway and return the same code.\n" % wrong_topology)
        return EXIT_REFUSED

    lib, which, tried = load_loader(request.get("loader") or os.environ.get("VK_LOADER"))
    if lib is None:
        sys.stderr.write("could not load the Vulkan loader. Looked for: %s\n" % ", ".join(tried))
        return EXIT_UNUSABLE
    note("loader            %s" % which)

    poke = Poke(bind(lib), note)
    try:
        # A real driver fault cannot be induced on demand, and an untested exit path is a
        # claim rather than a behaviour - so the request can ask for one.
        if request.get("faultForTesting"):
            raise OSError("exception: access violation reading 0x0000000000000000")
        code, error = poke.build(request)
    except OSError as e:
        # On Windows, CPython turns a driver access violation into a catchable OSError. Caught
        # here so it cannot fall through to the success path - and the process is ended at once
        # rather than unwinding, because `destroy` would make more calls into a driver that has
        # already faulted.
        sys.stderr.write("the display driver faulted while compiling this shader: %s\n" % e)
        sys.stderr.flush()
        os._exit(EXIT_FAULTED)
    else:
        poke.destroy()

    # Read after teardown, so anything the layer objects to at destruction is counted too.
    seen = poke.validation
    if seen:
        for line in seen.warnings:
            note("validation warning: %s" % line.split("The Vulkan spec states")[0].strip())

    # The layer's verdict comes before the VkResult, because it is the one that explains
    # anything. With validation active a bad pipeline usually fails as
    # VK_ERROR_VALIDATION_FAILED_EXT, and reporting only that says a call failed without
    # saying which rule it broke - which is the entire question.
    if seen and seen.errors:
        sys.stderr.write("the validation layer reports %d error(s):\n" % len(seen.errors))
        for line in seen.errors:
            sys.stderr.write("  %s\n" % line.split("The Vulkan spec states")[0].strip())
        if not error:
            sys.stderr.write(
                "The pipeline was created anyway and the microcode is probably right - this "
                "driver is lenient. That is exactly why this is fatal: the same leniency hid "
                "a disabled dynamicRendering behind correct output.\n")
        return EXIT_INVALID

    if error:
        sys.stderr.write("%s\n" % error)
        return code

    if seen:
        note("validation        clean (%d warning(s))" % len(seen.warnings))
    note("ok")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv))
