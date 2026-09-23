/* Integration fixture: a TypeScript Express service.
 *
 * It reports the facts the integration suite needs to prove from OUTSIDE the
 * container: the uid/gid the process really runs as, whether a devDependency
 * survived the production prune, and an environment variable read at runtime. */
import { createRequire } from "node:module";
import express from "express";

const localRequire = createRequire(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);

/** True when a devDependency is still resolvable, i.e. the prune did not happen. */
function devDependencyPresent(): boolean {
  try {
    localRequire.resolve("typescript");
    return true;
  } catch {
    return false;
  }
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    gid: typeof process.getgid === "function" ? process.getgid() : null,
    greeting: process.env.GREETING ?? "default-greeting",
    devDependencyPresent: devDependencyPresent(),
    nodeEnv: process.env.NODE_ENV ?? null,
  });
});

app.get("/", (_req, res) => {
  res.type("text/plain").send("fixture-express-ts-pnpm\n");
});

const server = app.listen(port, () => {
  console.log(`listening on ${port}`);
});

// Node is PID 1 in the container and receives SIGTERM directly.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, closing server`);
    server.close(() => process.exit(0));
  });
}
