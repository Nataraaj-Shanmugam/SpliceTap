// Jest config (audit finding CQ-Q14): jest-environment-jsdom is a
// devDependency but nothing selected it, so Jest silently used its own
// default. None of the current test suites reference `document`/`window`
// (all cover pure logic: matcher, patch, placeholders, utils, dnr), so the
// default here is 'node' — faster, and it's what's actually being exercised
// today. A future test that needs real DOM APIs can opt in per-file with an
// "@jest-environment jsdom" docblock at the top of that file, rather than
// paying jsdom's setup cost on every suite.
module.exports = {
    testEnvironment: 'node'
};
