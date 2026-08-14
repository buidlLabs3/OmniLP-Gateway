import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const checks = [
  {
    name: "Local tests",
    args: [
      "--test",
      fileURLToPath(new URL("./quote.test.mjs", import.meta.url)),
      fileURLToPath(new URL("./route.test.mjs", import.meta.url)),
      fileURLToPath(new URL("./ston.test.mjs", import.meta.url)),
    ],
  },
  {
    name: "Omniston quotes",
    args: [fileURLToPath(new URL("./quote.mjs", import.meta.url))],
  },
  {
    name: "STON.fi pools",
    args: [fileURLToPath(new URL("./ston.mjs", import.meta.url))],
  },
];

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: process.env,
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

let failed = false;
for (const check of checks) {
  console.log(`\n${check.name}`);
  const code = await run(check.args);
  if (code !== 0) {
    failed = true;
    console.error(`${check.name} did not pass (exit ${code}).`);
  }
}

if (failed) {
  console.error(
    "Gate A is incomplete. Resolve quote, wallet, LP, gas, withdrawal, and exit checks before scaffolding.",
  );
  process.exitCode = 1;
} else {
  console.log(
    "Read-only Gate A checks passed. Signed small-value proofs are still required.",
  );
}
