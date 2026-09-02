import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformAsync } from "@babel/core";
import { defineConfig, type Plugin } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const r = (p: string) => path.resolve(rootDir, p);

/**
 * Runs babel-plugin-react-compiler over `src/**` before Vite's own transform,
 * mirroring the production build (next.config.ts sets reactCompiler: true).
 * @vitejs/plugin-react v6 no longer exposes a babel pipeline that runs inside
 * Vitest's transform, so this applies the compiler explicitly. Babel parses
 * TS/JSX natively via parser plugins and re-emits TS/JSX for Vite to strip.
 */
const reactCompilerForTests = (): Plugin => ({
  name: "react-compiler-for-tests",
  enforce: "pre",
  async transform(code, id) {
    const filename = id.split("?")[0];
    if (!filename.startsWith(`${r("src")}/`)) return null;
    if (!/\.[jt]sx?$/.test(filename)) return null;
    const result = await transformAsync(code, {
      filename,
      babelrc: false,
      configFile: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
      generatorOpts: { retainLines: true },
      plugins: [["babel-plugin-react-compiler", {}]],
      sourceMaps: true,
    });
    if (!result?.code) return null;
    return { code: result.code, map: result.map };
  },
});

/**
 * Test / render-measurement config.
 *
 * The React Compiler babel plugin is applied here so component behaviour in
 * tests matches the production build (next.config.ts sets reactCompiler: true).
 * Without it, render-count measurements would overstate re-render costs.
 *
 * Module aliases (order matters — most specific first):
 *  - socket.io-client  → in-memory fake socket (tests can emit server events)
 *  - next/navigation   → controllable pathname/router mock
 *  - @iconify/react    → static stub (the real one fetches icon data over HTTP)
 *  - @/lib/api         → fixture-backed REST mock
 *  - @/components/ui/ChatBubble → real component wrapped in a <Profiler> that
 *    counts how often each bubble subtree actually renders
 */
export default defineConfig({
  plugins: [reactCompilerForTests()],
  resolve: {
    alias: [
      { find: /^socket\.io-client$/, replacement: r("tests/mocks/socket-io-client.ts") },
      { find: /^next\/navigation$/, replacement: r("tests/mocks/next-navigation.ts") },
      { find: /^@iconify\/react$/, replacement: r("tests/mocks/iconify.tsx") },
      { find: /^@\/lib\/api$/, replacement: r("tests/mocks/api.ts") },
      { find: /^@\/components\/ui\/ChatBubble$/, replacement: r("tests/instrumented/ChatBubble.tsx") },
      { find: /^@\/components\/chat\/Chatroom$/, replacement: r("tests/instrumented/Chatroom.tsx") },
      { find: /^@\/components\/layout\/Sidebar$/, replacement: r("tests/instrumented/Sidebar.tsx") },
      { find: /^@shared\/(.*)$/, replacement: `${r("../shared")}/$1` },
      { find: /^@\/(.*)$/, replacement: `${r("src")}/$1` },
    ],
  },
  test: {
    environment: "jsdom",
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["json-summary"],
      reportsDirectory: "./coverage",
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    // Serial execution keeps profiler numbers comparable between runs and
    // between test files (no parallel CPU contention while measuring).
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
