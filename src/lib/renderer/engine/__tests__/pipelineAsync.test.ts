import { describe, expect, it, vi } from 'vitest';
import { computePipelineAsync, renderPipelineAsync } from '../pipelineAsync';

// #803 — pipelines compile through the async entry points when the device
// has them, so the ride can await every compile before it reports ready.
describe('pipelineAsync (#803)', () => {
  const renderDesc = { label: 'r' } as unknown as GPURenderPipelineDescriptor;
  const computeDesc = { label: 'c' } as unknown as GPUComputePipelineDescriptor;

  it('uses createRenderPipelineAsync when the device has it', async () => {
    const pipeline = { label: 'async' } as unknown as GPURenderPipeline;
    const device = {
      createRenderPipelineAsync: vi.fn(() => Promise.resolve(pipeline)),
      createRenderPipeline: vi.fn(),
    } as unknown as GPUDevice;
    await expect(renderPipelineAsync(device, renderDesc)).resolves.toBe(pipeline);
    expect(device.createRenderPipelineAsync).toHaveBeenCalledWith(renderDesc);
    expect(device.createRenderPipeline).not.toHaveBeenCalled();
  });

  it('falls back to createRenderPipeline on a device without the async entry point', async () => {
    const pipeline = { label: 'sync' } as unknown as GPURenderPipeline;
    const device = { createRenderPipeline: vi.fn(() => pipeline) } as unknown as GPUDevice;
    await expect(renderPipelineAsync(device, renderDesc)).resolves.toBe(pipeline);
    expect(device.createRenderPipeline).toHaveBeenCalledWith(renderDesc);
  });

  it('uses createComputePipelineAsync when the device has it', async () => {
    const pipeline = { label: 'async' } as unknown as GPUComputePipeline;
    const device = {
      createComputePipelineAsync: vi.fn(() => Promise.resolve(pipeline)),
      createComputePipeline: vi.fn(),
    } as unknown as GPUDevice;
    await expect(computePipelineAsync(device, computeDesc)).resolves.toBe(pipeline);
    expect(device.createComputePipeline).not.toHaveBeenCalled();
  });

  it('falls back to createComputePipeline on a device without the async entry point', async () => {
    const pipeline = { label: 'sync' } as unknown as GPUComputePipeline;
    const device = { createComputePipeline: vi.fn(() => pipeline) } as unknown as GPUDevice;
    await expect(computePipelineAsync(device, computeDesc)).resolves.toBe(pipeline);
  });

  it('passes a failed async compile through as a rejection', async () => {
    const device = {
      createRenderPipelineAsync: vi.fn(() => Promise.reject(new Error('GPUPipelineError'))),
    } as unknown as GPUDevice;
    await expect(renderPipelineAsync(device, renderDesc)).rejects.toThrow('GPUPipelineError');
  });
});
