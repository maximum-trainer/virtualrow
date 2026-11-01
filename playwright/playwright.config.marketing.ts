import { defineConfig } from '@playwright/test';
import ci from './playwright.config.ci';

/**
 * #648 — regenerate the marketing screenshots on a real-GPU runner.
 *
 * This config pairs with `playwright/tests/visual/marketing-screenshots.spec.ts`
 * and is run only by `regen-marketing-shots.yml` on `linux-nvidia-gpu-runner`.
 * It inherits webserver + reporter from the CI config and swaps the
 * launchOptions to real WebGPU (SwiftShader is a non-starter — the engine
 * declines software adapters and the spec fast-fails on that path).
 *
 * No retries: a retry of a screenshot either produces the same PNG (wasted
 * minutes on the T4) or a different one (a GPU-driver nondeterminism bug worth
 * knowing about, not papering over).
 */
export default defineConfig({
  ...ci,
  testDir: './tests',
  testMatch: '**/visual/marketing-screenshots.spec.ts',
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'playwright-report/marketing-shots/playwright-report.json' }]],
  use: {
    ...ci.use,
    launchOptions: {
      ...(process.env.PW_LOCAL_CHROME ? { executablePath: process.env.PW_LOCAL_CHROME } : {}),
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    },
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
  projects: [{ name: 'marketing' }],
});
