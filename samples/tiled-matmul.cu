// nv-isa-extractor -use_fast_math -Xptxas -v
//
// A tiled matrix multiply, as an input for **NVIDIA ISA: Compile and Disassemble**
// (Ctrl+Alt+Shift+B). Nothing here is novel - it is the textbook kernel - and that is the
// point: the SASS it produces is the shape most people already have a mental model of, so
// the listing can be read against an expectation.
//
// The first line of this file is a compile-flags directive. `-use_fast_math` goes to the
// CUDA front end and `-Xptxas -v` reaches the assembler, whose register and shared-memory
// report ends up in the listing's banner. Change either and recompile to see the SASS move.
//
// What to look for in the generated listing:
//
//   LDG.E ... [R2.64]        a global load, arming a scoreboard in the W field
//   [B0-----:...]            the wait that drains it, several instructions later - put the
//                            cursor on the 0 and the loads that armed it light up
//   STS / LDS                the staging through shared memory
//   BAR.SYNC                 __syncthreads(), between the store and the load
//   IMAD.WIDE                32-bit index times 4, widened to a 64-bit address
//   FFMA                     the inner product, fully unrolled
//
// The two loads into the tiles are independent, so the compiler issues both before waiting
// on either. That is the single most characteristic thing about SASS scheduling and it is
// visible in the control column rather than in the instruction stream.
//
// What you will *not* find here is a BSSY/BSYNC pair. The boundary check at the bottom is
// short enough that the compiler predicates it - three instructions carrying an `@P0` guard -
// rather than branching around it and reconverging. The banner counts both, so it says
// "1 backward branch" for the tile loop and reports no BSSY/BSYNC pairs at all.
// `samples/prefix-blur.slang` has three of them, if that is what you came to look at.

#define TILE 16

extern "C" __global__ void tiledMatmul(
    const float* __restrict__ a,
    const float* __restrict__ b,
    float* __restrict__ c,
    int n)
{
    __shared__ float aTile[TILE][TILE];
    __shared__ float bTile[TILE][TILE];

    const int tx = threadIdx.x;
    const int ty = threadIdx.y;
    const int row = blockIdx.y * TILE + ty;
    const int col = blockIdx.x * TILE + tx;

    float acc = 0.0f;

    for (int t = 0; t < n / TILE; ++t) {
        // Two independent global loads. The compiler arms a scoreboard for each and waits
        // for both at the store below, rather than serialising them.
        aTile[ty][tx] = a[row * n + t * TILE + tx];
        bTile[ty][tx] = b[(t * TILE + ty) * n + col];

        __syncthreads();

        // Fully unrolled by the compiler, so one source line maps to a long run of FFMAs -
        // an ordinary case of correlation being many-to-one.
        for (int k = 0; k < TILE; ++k) {
            acc += aTile[ty][k] * bTile[k][tx];
        }

        __syncthreads();
    }

    // Predicated rather than branched: the body is one store, so guarding it costs less than
    // a branch and a reconvergence would.
    if (row < n && col < n) {
        c[row * n + col] = acc;
    }
}
