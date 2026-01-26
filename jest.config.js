export default {
  testEnvironment: "node",
  testMatch: [
    "<rootDir>/tests/security/**/*.test.js",
    "<rootDir>/tests/adapters/**/*.test.js"
  ],
  clearMocks: true,
  restoreMocks: true,
};
