// Headless end-to-end suite: loads the real extension into Chrome for Testing
// (see tests/e2e/harness.js). Kept out of the default `npm test` run because
// it launches a browser per file; run it with `npm run test:e2e`.
module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/e2e/**/*.e2e.test.js'],
    testTimeout: 60000,
    // One browser at a time: parallel Chrome instances on a developer machine
    // make timing-sensitive assertions (delays, batching windows) flaky.
    maxWorkers: 1
};
