/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/src/**/*.test.ts", "<rootDir>/prisma/scripts/**/*.test.ts"],
  setupFiles: ["dotenv/config"],
  testTimeout: 15000,
  maxWorkers: 1,
  workerIdleMemoryLimit: "512MB",
};
