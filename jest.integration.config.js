// Integration tests against real services (today: the job store's and rate limiter's Upstash scripts). Plain Node,
// without the jest-expo preset, whose fetch stub can't reach the network. Run with:
//   UPSTASH_INTEGRATION=1 UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... npx jest -c jest.integration.config.js
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/src/server/__tests__/jobStore.test.ts', '**/src/server/__tests__/rateLimit.test.ts'],
  transform: { '\\.[jt]sx?$': ['babel-jest', { presets: ['babel-preset-expo'] }] },
  transformIgnorePatterns: ['/node_modules/(?!@upstash)'],
  watchman: false,
};
