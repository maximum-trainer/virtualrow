/**
 * #803 — create pipelines with the async entry points.
 *
 * `createRenderPipeline` returns at once, but Chrome then compiles the
 * pipeline on the GPU process's main thread, in line with every other
 * WebGPU command: frames submitted after it wait for the compile. At ride
 * start that queue held 400–700 ms of compiles and the first strokes froze
 * behind it. `createRenderPipelineAsync` compiles off that thread and tells
 * us when it is done, so the engine can await every pipeline before the
 * ride shows as ready.
 *
 * A device without the async entry points (the unit-test mocks) falls back
 * to the sync ones, so the callers stay the same either way.
 */
export const renderPipelineAsync = (
  device: GPUDevice,
  descriptor: GPURenderPipelineDescriptor,
): Promise<GPURenderPipeline> =>
  typeof device.createRenderPipelineAsync === 'function'
    ? device.createRenderPipelineAsync(descriptor)
    : Promise.resolve(device.createRenderPipeline(descriptor));

export const computePipelineAsync = (
  device: GPUDevice,
  descriptor: GPUComputePipelineDescriptor,
): Promise<GPUComputePipeline> =>
  typeof device.createComputePipelineAsync === 'function'
    ? device.createComputePipelineAsync(descriptor)
    : Promise.resolve(device.createComputePipeline(descriptor));
