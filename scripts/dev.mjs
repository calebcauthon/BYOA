import { spawn } from "node:child_process";
import { createServer } from "node:net";

const host = process.env.HOST ?? "127.0.0.1";
const stateDir = process.env.AUTOMATIONS_STATE_DIR ?? ".automations-state";

// Probe whether `candidate` is free, binding the SAME way the eventual
// consumer will. This matters: the api does `server.listen(port)` with no host,
// so Node binds the IPv6 wildcard (`::`, shown as `*:7700`); a probe bound to
// `127.0.0.1` would see that as free and hand back a port the api then can't
// bind. Passing `bindHost === undefined` reproduces the wildcard bind exactly;
// the console gets probed on `127.0.0.1` because it launches with `--host`.
function isPortFree(candidate, bindHost) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    if (bindHost === undefined) srv.listen(candidate);
    else srv.listen(candidate, bindHost);
  });
}

// Starting at `preferred`, walk upward to the first free port. Lets `make dev`
// run on a clean checkout without anyone setting PORT — if 7700/5173 are taken
// (e.g. a stale dev stack), we pick the next open port instead of dying with
// "address in use". An explicitly-set env var is respected as-is.
async function resolvePort(envValue, preferred, bindHost) {
  if (envValue) return envValue; // caller asked for a specific port; honor it
  for (let candidate = preferred; candidate < preferred + 100; candidate++) {
    if (await isPortFree(candidate, bindHost)) return String(candidate);
  }
  throw new Error(`no free port found near ${preferred}`);
}

// api binds the wildcard (no host); console binds `host` via vite --host.
const port = await resolvePort(process.env.PORT, 7700, undefined);
const consolePort = await resolvePort(process.env.CONSOLE_PORT, 5173, host);

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
