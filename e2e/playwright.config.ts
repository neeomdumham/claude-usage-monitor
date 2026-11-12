import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  outputDir: 'out/results',
  reporter: [['list']],
  workers: 1, // tests share one seeded database
  use: {
    baseURL: process.env.BASE_URL ?? 'http://app-e2e:8787',
    viewport: { width: 1440, height: 1000 },
    timezoneId: 'Asia/Dhaka',
    trace: 'retain-on-failure',
  },
});
