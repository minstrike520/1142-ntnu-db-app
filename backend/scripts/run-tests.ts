import { Glob } from "bun";
import { spawnSync } from "child_process";
import path from "path";

const args = Bun.argv.slice(2);
const folder = args[0] || "tests";

// Instantiate the Glob pattern
const glob = new Glob("**/*.test.ts");

// Scan the target directory synchronously
const files = Array.from(glob.scanSync({
  cwd: path.resolve(process.cwd(), folder),
  absolute: true,
})).sort();

console.log(`Found ${files.length} test files under ${folder}`);

let passed = 0;
let failed = 0;
const failedFiles: string[] = [];

for (const file of files) {
  const relativePath = path.relative(process.cwd(), file);
  console.log(`\n============================================`);
  console.log(`Running: ${relativePath}`);
  console.log(`============================================\n`);
  
  const result = spawnSync("bun", ["test", file], { stdio: "inherit" });
  
  if (result.status === 0) {
    passed++;
  } else {
    failed++;
    failedFiles.push(relativePath);
  }
}

console.log(`\n============================================`);
console.log(`Test Execution Summary:`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed > 0) {
  console.log(`\nFailed Files:`);
  for (const f of failedFiles) {
    console.log(`  - ${f}`);
  }
  process.exit(1);
} else {
  console.log(`\nAll tests passed successfully! 🎉`);
  process.exit(0);
}
