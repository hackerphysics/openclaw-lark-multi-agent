import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", setupFiles: ["tests/normal-flow-offline-guard.ts"], include: ["tests/**/*.test.ts"], exclude: ["tests/repair-acceptance/**", "**/node_modules/**"], testTimeout: 15000, hookTimeout: 10000 } });
