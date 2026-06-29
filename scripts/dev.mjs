import { spawn } from "node:child_process";

const host = process.env.HOST ?? "127.0.0.1";
const port = process.env.PORT ?? "7700";
const consolePort = process.env.CONSOLE_PORT ?? "5173";
const stateDir = process.env.AUTOMATIONS_STATE_DIR ?? ".automations-state";

const children = new Set();
let shuttingDown = false;

function start(name, command, args, env) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["inherit", "pipe", "pipe"],
  });
  children.add(child);

  const prefix = `[${name}] `;
  child.stdout.on("data", (chunk) => process.stdout.write(prefix + String(chunk).replace(/\n$/, "").replace(/\n/g, `\n${prefix}`) + "\n"));
  child.stderr.on("data", (chunk) => process.stderr.write(prefix + String(chunk).replace(/\n$/, "").replace(/\n/g, `\n${prefix}`) + "\n"));
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      const why = signal ? `signal ${signal}` : `exit ${code ?? 0}`;
      process.stderr.write(`[dev] ${name} stopped (${why}); stopping dev stack\n`);
      shutdown(code ?? (signal ? 1 : 0));
    }
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 2500).unref();
  setTimeout(() => process.exit(code), 100).unref();
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

process.stdout.write(`orchestrator: http://${host}:${port}\n`);
process.stdout.write(`console:      http://${host}:${consolePort}\n`);

start("api", "node", ["packages/orchestrator/src/main.ts"], {
  PORT: port,
  AUTOMATIONS_STATE_DIR: stateDir,
});

start("ui", "npm", ["run", "dev", "-w", "@automations/console", "--", "--host", host, "--port", consolePort], {
  VITE_API_BASE: `http://${host}:${port}`,
});
