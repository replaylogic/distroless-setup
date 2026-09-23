/* Helpers for the Docker-backed integration tests.
 *
 * Every fixture follows the same flow:
 *   copy fixture -> run the real CLI (--yes) -> docker build -> docker run ->
 *   probe from outside the container -> inspect -> clean up.
 *
 * Nothing here touches the repository working tree: fixtures are copied to a temp
 * directory first, so a run can never leave a Dockerfile or a report behind.
 */
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const CLI = path.join(REPO, "dist", "cli.js");
const FIXTURES = path.join(REPO, "test", "fixtures");

/** Binaries that must NOT be runnable in a distroless runtime image. */
const FORBIDDEN_ENTRYPOINTS = ["sh", "/bin/sh", "bash", "/bin/bash", "npm", "pip", "pip3", "curl", "wget", "apt-get"];

const DEBUG = Boolean(process.env.DISTROLESS_IT_DEBUG);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout ?? 30 * 60 * 1000,
    ...opts,
  });
  if (DEBUG) process.stderr.write(`$ ${cmd} ${args.join(" ")}\n${r.stdout ?? ""}${r.stderr ?? ""}\n`);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

function must(label, r) {
  if (r.status !== 0) {
    throw new Error(`${label} failed (exit ${r.status})\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
  }
  return r.stdout;
}

const docker = (...args) => run("docker", args);
const dockerMust = (label, ...args) => must(label, docker(...args));

/** True when a Linux Docker daemon is reachable. Integration tests skip otherwise. */
function dockerAvailable() {
  const r = run("docker", ["version", "--format", "{{.Server.Os}}"], { timeout: 60000 });
  return r.status === 0 && r.stdout.trim() === "linux";
}

// ---- fixtures -----------------------------------------------------------------------------

/** Copies a fixture into a fresh temp dir and returns its path. */
function copyFixture(name) {
  const src = path.join(FIXTURES, name);
  assert.ok(fs.existsSync(src), `fixture ${name} not found at ${src}`);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `dls-it-${name}-`));
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => !/[\\/](node_modules|\.next|dist|__pycache__|\.angular)([\\/]|$)/.test(p),
  });
  return dest;
}

/** Every file in a tree as `relative path -> content`, for "nothing changed" assertions. */
function snapshot(dir) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.set(path.relative(dir, p).split(path.sep).join("/"), fs.readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
}

// ---- the CLI ------------------------------------------------------------------------------

/**
 * Runs the compiled CLI over a project directory with `--yes`, so every answer is the
 * detected default. Fixtures are written so those defaults are the path under test.
 */
function runCli(stack, dir, extraArgs = []) {
  const r = run(process.execPath, [CLI, stack, dir, "--yes", ...extraArgs], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: "1", DISTROLESS_SETUP_ASCII: "1", FORCE_COLOR: "" },
    timeout: 5 * 60 * 1000,
  });
  must(`distroless-setup ${stack} ${dir}`, r);
  return r.stdout;
}

// ---- images and containers ------------------------------------------------------------------

function buildImage(dir, tag) {
  dockerMust(`docker build ${tag}`, "build", "-t", tag, dir);
  return tag;
}

function removeImage(tag) {
  docker("image", "rm", "-f", tag);
}

/**
 * Starts a container with an ephemeral host port bound to loopback and returns
 * { id, url, port }. Health-check *timing* is compressed so a test does not wait 30s
 * per probe; the health *command* still comes from the generated image.
 */
function startContainer(tag, { port, env = {}, args = [], name } = {}) {
  const runArgs = ["run", "-d", "-p", `127.0.0.1:0:${port}`,
    "--health-interval=2s", "--health-timeout=5s", "--health-start-period=2s", "--health-retries=5"];
  if (name) runArgs.push("--name", name);
  for (const [k, v] of Object.entries(env)) runArgs.push("-e", `${k}=${v}`);
  runArgs.push(...args, tag);
  const id = dockerMust(`docker run ${tag}`, ...runArgs).trim();
  const mapped = dockerMust("docker port", "port", id, String(port)).trim().split(/\r?\n/)[0];
  const hostPort = mapped.slice(mapped.lastIndexOf(":") + 1);
  return { id, port: hostPort, url: `http://127.0.0.1:${hostPort}` };
}

function logs(id) {
  const r = docker("logs", id);
  return `${r.stdout}\n${r.stderr}`;
}

function stopContainer(id) {
  if (!id) return;
  docker("stop", "-t", "3", id);
  docker("rm", "-f", id);
}

function inspect(id, format) {
  const r = docker("inspect", "--format", format, id);
  return r.status === 0 ? r.stdout.trim() : "";
}

// ---- waiting ---------------------------------------------------------------------------------

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function waitFor(what, fn, { timeout = 120000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = "predicate returned falsy";
    } catch (e) {
      last = e.message;
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout}ms waiting for ${what} (last: ${last})`);
    await sleep(interval);
  }
}

/** HTTP request from the test process, i.e. from OUTSIDE the container. */
async function http(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10000);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal, redirect: "manual" });
    return { status: res.status, headers: res.headers, body: await res.text() };
  } finally {
    clearTimeout(t);
  }
}

/** Waits until the published port answers, failing loudly with container logs if it never does. */
async function waitForHttp(container, pathname, { timeout = 120000, expect = 200 } = {}) {
  try {
    return await waitFor(`${container.url}${pathname}`, async () => {
      const r = await http(container.url + pathname, { timeoutMs: 5000 });
      return r.status === expect ? r : false;
    }, { timeout });
  } catch (e) {
    throw new Error(`${e.message}\n--- container logs ---\n${logs(container.id)}`);
  }
}

async function waitForHealthy(container, { timeout = 120000 } = {}) {
  try {
    return await waitFor("health status 'healthy'", () => {
      const st = inspect(container.id, "{{.State.Health.Status}}");
      if (st === "unhealthy") throw new Error("container reported unhealthy");
      assert.notEqual(st, "", "container has no HEALTHCHECK state; the image declared none");
      return st === "healthy" ? st : false;
    }, { timeout });
  } catch (e) {
    throw new Error(`${e.message}\n--- container logs ---\n${logs(container.id)}`);
  }
}

// ---- shared assertions -------------------------------------------------------------------------

/**
 * Proves the runtime image really has no shell, package manager or download tool,
 * rather than assuming it from the base image name.
 */
function assertNoShellOrPackageManager(tag) {
  for (const bin of FORBIDDEN_ENTRYPOINTS) {
    const r = docker("run", "--rm", "--entrypoint", bin, tag, "-c", "echo reachable");
    assert.notEqual(r.status, 0, `'${bin}' was runnable inside ${tag}; the runtime image is not distroless`);
    assert.doesNotMatch(String(r.stdout), /reachable/, `'${bin}' executed inside ${tag}`);
  }
}

/** The image declares a non-root user, and the process really runs as it. */
function assertNonRoot(container, tag) {
  const declared = docker("image", "inspect", "--format", "{{.Config.User}}", tag).stdout.trim();
  assert.equal(declared, "65532:0", `image ${tag} should declare USER 65532:0`);

  // docker top reads the host process table: no shell is needed inside the container.
  const top = dockerMust("docker top", "top", container.id, "-o", "user,pid,args");
  const rows = top.trim().split(/\r?\n/).slice(1).filter(Boolean);
  assert.ok(rows.length, `docker top returned no processes for ${tag}`);
  for (const row of rows) {
    const user = row.trim().split(/\s+/)[0];
    assert.ok(user !== "root" && user !== "0", `a process runs as root in ${tag}: ${row}`);
  }
}

/** The app itself reports the uid/gid it runs under: the strongest proof available. */
function assertReportedIdentity(body) {
  const data = typeof body === "string" ? JSON.parse(body) : body;
  assert.equal(data.uid, 65532, `app reports uid ${data.uid}, expected 65532`);
  assert.equal(data.gid, 0, `app reports gid ${data.gid}, expected 0`);
  return data;
}

/**
 * The read-only run the generated report tells the user to perform, as `docker run` args.
 * Driving the test from the report means a mismatch between what the docs claim and what
 * the image needs shows up as a failure rather than going unnoticed.
 */
function readOnlyArgsFromReport(dir) {
  const report = readGenerated(dir, "DISTROLESS-MIGRATION.md");
  const m = /^docker run --rm --read-only ([^\n]*?) ?-p \d+:\d+ /m.exec(report);
  assert.ok(m, `the report should document a --read-only run:\n${report.slice(0, 4000)}`);
  const mounts = m[1].trim() ? m[1].trim().split(/\s+/) : [];
  assert.ok(mounts.length % 2 === 0, `unexpected mount arguments in the report: ${m[1]}`);
  for (let i = 0; i < mounts.length; i += 2) assert.equal(mounts[i], "--tmpfs");
  return { args: ["--read-only", ...mounts], mounts: mounts.filter((x) => x !== "--tmpfs") };
}

function readGenerated(dir, rel) {
  const p = path.join(dir, rel);
  assert.ok(fs.existsSync(p), `expected the CLI to generate ${rel}`);
  return fs.readFileSync(p, "utf8");
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows can hold locks briefly; a leftover temp dir is harmless. */
  }
}

module.exports = {
  REPO, CLI, FIXTURES, FORBIDDEN_ENTRYPOINTS,
  run, must, docker, dockerMust, dockerAvailable,
  copyFixture, snapshot, runCli,
  buildImage, removeImage, startContainer, stopContainer, inspect, logs,
  sleep, waitFor, http, waitForHttp, waitForHealthy,
  assertNoShellOrPackageManager, assertNonRoot, assertReportedIdentity,
  readGenerated, readOnlyArgsFromReport, cleanupDir,
};
