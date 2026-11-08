import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server/src/index.js");

// Runs Console and starts it again when it asks for a restart (exit code 75: after an update or the Restart button).
// Anything else (Ctrl+C, a crash) ends it, so a broken start doesn't loop forever.
export function supervise() {
  let child = null;
  let stopping = false;
  const launch = () => {
    child = spawn(process.execPath, [entry], { stdio: "inherit", env: { ...process.env, CONSOLE_SUPERVISED: "1" } });
    child.on("exit", (code, signal) => {
      if (!stopping && code === 75) {
        console.log("\nRestarting Console…\n");
        return setTimeout(launch, 500);
      }
      process.exit(code ?? (signal ? 1 : 0));
    });
  };
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      stopping = true;
      child?.kill(sig);
    });
  }
  launch();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) supervise();
