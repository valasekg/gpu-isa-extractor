// Experiment 6: what do RDNA wait instructions actually say?
//
// Designed to put several kinds of memory operation in flight at once, so the compiler has to
// emit waits that distinguish them:
//
//   two SMEM loads   - uniform reads, which retire OUT OF ORDER on gfx10/11's lgkmcnt
//   one LDS read     - shares lgkmcnt with SMEM on gfx10/11, separate dscnt on gfx12
//   two VMEM loads   - vmcnt on gfx10/11, loadcnt on gfx12
//   a VMEM store     - vscnt on gfx10/11, storecnt on gfx12
//
// The uses are interleaved so the compiler cannot simply wait for everything at once.

struct Params { uint a; uint b; uint c; uint d; };
ConstantBuffer<Params> params;

RWStructuredBuffer<float> inBuf;
RWStructuredBuffer<float> outBuf;
groupshared float tile[64];

[shader("compute")]
[numthreads(64, 1, 1)]
void csMain(uint3 tid : SV_DispatchThreadID, uint3 gtid : SV_GroupThreadID)
{
    // Two scalar loads from the constant buffer, at uniform offsets.
    uint ia = params.a;
    uint ib = params.b;

    // Two vector loads, issued before either scalar value is consumed.
    float v0 = inBuf[tid.x];
    float v1 = inBuf[tid.x + 1];

    // An LDS write and a barrier, so the LDS read below genuinely has to wait.
    tile[gtid.x] = v0;
    GroupMemoryBarrierWithGroupSync();
    float shared0 = tile[63 - gtid.x];

    // Consume the scalar values only now, so their wait is separable from the vector one.
    float scaled = v1 * float(ia) + shared0 * float(ib);

    // A store, then more work, so the store counter is outstanding across it.
    outBuf[tid.x] = scaled;
    outBuf[tid.x + 1] = scaled * float(params.c) + float(params.d);
}
