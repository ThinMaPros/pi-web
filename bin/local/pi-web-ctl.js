#!/usr/bin/env node
"use strict";

// local: `pi-web` entry for this fork. Adds background control on top of the
// upstream launcher (bin/pi-web.js), which still runs the server itself.
//
//   pi-web [options]   foreground (upstream behaviour, Ctrl+C to stop)
//   pi-web start       background, opens the browser, returns the shell
//   pi-web stop        stop the background server
//   pi-web status      show whether it runs and where
//   pi-web logs [-f]   print (or follow) the background log
//
// Config: ~/.pi/agent/pi-web/pi-web.json  { "port", "tailscale", "tailscalePort", "password", "open" }

/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn, execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
// local: preserve legacy CLI files while moving them under pi-web/ without replacing newer files.
function piWebDataPath(name, baseDir = agentDir) {
  const directory = path.join(baseDir, "pi-web");
  const destination = path.join(directory, name);
  const legacy = path.join(baseDir, name);
  if (!fs.existsSync(destination) && fs.existsSync(legacy)) {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      // local: link claims the destination atomically; POSIX rename could overwrite a concurrent file.
      fs.linkSync(legacy, destination);
      fs.unlinkSync(legacy);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error;
    }
  }
  return destination;
}
const configPath = piWebDataPath("pi-web.json"); // local: config data directory.
const pidPath = piWebDataPath("pi-web.pid"); // local: pid data directory.
const watcherPidPath = piWebDataPath("pi-web-tailscale-watch.pid"); // local: watcher pid data directory.
const logPath = piWebDataPath("pi-web.log"); // local: log data directory.
function ensureDataDirectory(file) { // local: reads don't create pi-web/; writers do.
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}
const pkgDir = path.join(__dirname, "..", "..");
const upstreamBin = path.join(pkgDir, "bin", "pi-web.js");
const HOST = "127.0.0.1";
const { getRunDir, isRecordProcess, listRunRecords, readProcessCommand, selectRunRecord } = require(path.join(pkgDir, "bin", "run-records.js"));

function parseConfig(raw = {}, env = {}, argv = []) {
  raw = raw && typeof raw === "object" ? raw : {};
  const warnings = [];
  const parsedTailscalePort = parseTailscalePort(raw.tailscalePort);
  const tailscalePort = parsedTailscalePort.port;
  warnings.push(...parsedTailscalePort.warnings);
  return {
    port: String(raw.port ?? env.PORT ?? 30141),
    tailscale: raw.tailscale === true,
    tailscalePort,
    password: typeof raw.password === "string" && raw.password ? raw.password : undefined,
    open: raw.open !== false && !/^(1|true|yes|on)$/i.test(env.PI_WEB_NO_OPEN ?? "") && !argv.includes("--no-open"),
    warnings,
  };
}

function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") fail(`Cannot read ${configPath}: ${error.message}`);
  }
  const config = parseConfig(raw, process.env, process.argv);
  for (const warning of config.warnings) console.warn(`pi-web: ${warning}.`);
  return config;
}

function fail(message) {
  console.error(`pi-web: ${message}`);
  process.exit(1);
}

function readPid(file = pidPath) {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function runningPid(file = pidPath) {
  const pid = readPid(file);
  if (pid && isAlive(pid) && isRecordProcess(pid, "launcher")) return pid;
  if (pid) fs.rmSync(file, { force: true });
  return null;
}

function isWatcherProcess(pid) {
  if (!pid || !isAlive(pid) || !isRecordProcess(pid, "launcher")) return false;
  const command = readProcessCommand(pid);
  return command === null || (command.includes("pi-web-ctl.js") && command.includes("__tailscale-watch"));
}

function runningWatcherPid() {
  const pid = readPid(watcherPidPath);
  if (pid && isWatcherProcess(pid)) return pid;
  if (pid) fs.rmSync(watcherPidPath, { force: true });
  return null;
}

async function runRecordForPort(port) {
  const records = await listRunRecords(getRunDir());
  return selectRunRecord(records, port);
}

function forwardUpstream(args) {
  const result = spawnSync(process.execPath, [upstreamBin, ...args], {
    cwd: pkgDir,
    stdio: "inherit",
  });
  if (result.error) fail(`could not run upstream command: ${result.error.message}`);
  process.exitCode = result.status ?? 1;
}

function ping(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: HOST, port, path: "/", timeout: 2000 }, (response) => {
      response.resume();
      resolve(true);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Tailscale -------------------------------------------------------------

function tailscale(args) {
  return execFileSync("tailscale", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function parseTailscalePort(value) {
  const warnings = [];
  let port = value ?? 8443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    warnings.push("invalid tailscalePort; using 8443");
    port = 8443;
  } else if (port === 443) {
    warnings.push("tailscalePort 443 is reserved for another service; using 8443");
    port = 8443;
  }
  return { port, warnings };
}

function dnsNameFromStatus(status) {
  return String(status?.Self?.DNSName ?? "").replace(/\.$/, "") || null;
}

function hasProxyTarget(value, target) {
  if (!value || typeof value !== "object") return false;
  if (value.Proxy === target) return true;
  return Object.values(value).some((child) => hasProxyTarget(child, target));
}

function isServeMappingPresent(statusInput, tailscalePort, localPort) {
  let status = statusInput;
  if (typeof statusInput === "string") {
    try {
      status = JSON.parse(statusInput);
    } catch {
      return false;
    }
  }
  if (!status || typeof status !== "object") return false;
  const target = `http://${HOST}:${localPort}`;
  const port = String(tailscalePort);
  const tcp = status.TCP;
  if (tcp && typeof tcp === "object") {
    const entry = tcp[port];
    if (entry && (entry.HTTPS === true || entry.HTTPS === "true") && hasProxyTarget(entry, target)) return true;
  }
  const web = status.Web;
  if (web && typeof web === "object") {
    return Object.entries(web).some(([listener, entry]) => {
      const match = /:(\d+)$/.exec(listener);
      return match?.[1] === port && hasProxyTarget(entry, target);
    });
  }
  return false;
}

function getTailscaleStatus() {
  try {
    const status = JSON.parse(tailscale(["status", "--json"]));
    return { status, dnsName: dnsNameFromStatus(status), running: status?.BackendState === "Running" };
  } catch (error) {
    return { status: null, dnsName: null, running: false, error };
  }
}

function isOurServeMapping(config) {
  try {
    return isServeMappingPresent(tailscale(["serve", "status", "--json"]), config.tailscalePort, config.port);
  } catch {
    return false;
  }
}

function ensureTailscaleMapping(config, tailStatus = getTailscaleStatus()) {
  if (!tailStatus.running) return false;
  if (isOurServeMapping(config)) return true;
  try {
    tailscale(["serve", "--bg", `--https=${config.tailscalePort}`, `http://${HOST}:${config.port}`]);
    return true;
  } catch (error) {
    console.warn(`pi-web: could not enable Tailscale serve (${firstLine(error)}).`);
    return false;
  }
}

/**
 * Removes our serve mapping. Tailscale keeps serve config while stopped but
 * refuses to edit it then ("Tailscale is stopped."), so a stopped Tailscale
 * leaves the mapping in place: "kept". `status`/`stop` remove it once it runs.
 */
function disableTailscale(config) {
  const snapshot = getTailscaleStatus();
  if (!isOurServeMapping(config)) return "absent";
  if (!snapshot.running) return "kept";
  try {
    tailscale(["serve", `--https=${config.tailscalePort}`, "off"]);
    return "removed";
  } catch (error) {
    console.warn(`pi-web: could not remove the Tailscale :${config.tailscalePort} mapping (${firstLine(error)}).`);
    return "failed";
  }
}

function warnKeptMapping(config) {
  console.warn(`pi-web: Tailscale is stopped, so its :${config.tailscalePort} mapping stays until Tailscale runs; \`pi-web status\` or \`pi-web stop\` removes it then.`);
}

function firstLine(error) {
  const text = String(error?.stderr || error?.message || error);
  return text.trim().split("\n")[0];
}

// --- Server environment ----------------------------------------------------

function ensureBuilt() {
  if (!fs.existsSync(path.join(pkgDir, ".next", "BUILD_ID"))) {
    fail(`no production build found. Run \`npm run build\` in ${pkgDir} first.`);
  }
}

function serverEnv(config, tailscaleHost) {
  const env = { ...process.env, PI_WEB_NO_OPEN: "1" };
  if (config.password) env.PI_WEB_PASSWORD = config.password;
  if (tailscaleHost) {
    env.PI_WEB_ALLOWED_HOSTS = [process.env.PI_WEB_ALLOWED_HOSTS, tailscaleHost].filter(Boolean).join(",");
  }
  return env;
}

function printUrls(port, tailscaleHost, tailscalePort = 8443) {
  console.log(`pi-web: http://${HOST}:${port}`);
  if (tailscaleHost) console.log(`pi-web: https://${tailscaleHost}:${tailscalePort} (Tailscale)`);
}

function openBrowser(url) {
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
}

// --- Commands --------------------------------------------------------------

function initialTailscaleSetup(config) {
  if (!config.tailscale) return { dnsName: null, connected: false };
  const snapshot = getTailscaleStatus();
  if (!snapshot.dnsName) {
    console.warn(`pi-web: Tailscale MagicDNS name is unknown${snapshot.error ? ` (${firstLine(snapshot.error)})` : ""}; a Tailscale connection will need a restart.`);
  }
  if (snapshot.running) {
    return { dnsName: snapshot.dnsName, connected: ensureTailscaleMapping(config, snapshot) };
  }
  console.warn("pi-web: serving on localhost only; will connect automatically when Tailscale starts.");
  return { dnsName: snapshot.dnsName, connected: false };
}

async function isPiWebProcessRunning(config) {
  const selection = await runRecordForPort(config.port);
  if (selection.record) return true;
  if (selection.error?.startsWith("No pi-web server is running")) return Boolean(runningPid());
  return false;
}

function startTailscaleWatcher() {
  const existing = runningWatcherPid();
  if (existing) return existing;
  ensureDataDirectory(logPath); // local: create data directory before writing logs.
  const log = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [__filename, "__tailscale-watch"], {
    cwd: pkgDir,
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  fs.closeSync(log);
  child.unref();
  ensureDataDirectory(watcherPidPath); // local: create data directory before writing watcher pid.
  fs.writeFileSync(watcherPidPath, String(child.pid));
  return child.pid;
}

async function stopTailscaleWatcher() {
  const pid = runningWatcherPid();
  if (!pid) return true;
  const signalWatcher = (signal) => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // The liveness check below determines whether it stopped.
      }
    }
  };
  signalWatcher("SIGTERM");
  for (let waited = 0; waited < 2_000 && isWatcherProcess(pid); waited += 100) await sleep(100);
  if (isWatcherProcess(pid)) signalWatcher("SIGKILL");
  for (let waited = 0; waited < 1_000 && isWatcherProcess(pid); waited += 100) await sleep(100);
  if (isWatcherProcess(pid)) {
    console.error(`pi-web: could not stop Tailscale watcher pid ${pid}; it is still running or cannot be signalled.`);
    return false;
  }
  fs.rmSync(watcherPidPath, { force: true });
  return true;
}

async function watchTailscale() {
  const config = loadConfig();
  const ownPid = process.pid;
  process.once("exit", () => {
    if (readPid(watcherPidPath) === ownPid) fs.rmSync(watcherPidPath, { force: true });
  });
  let lastConnected = false;
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      if (!config.tailscale || !(await isPiWebProcessRunning(config))) {
        process.exitCode = 0;
        process.exit();
        return;
      }
      const snapshot = getTailscaleStatus();
      const wasMapped = isOurServeMapping(config);
      const connected = ensureTailscaleMapping(config, snapshot);
      if (connected && snapshot.dnsName && (!lastConnected || !wasMapped)) {
        console.log(`pi-web: Tailscale available at https://${snapshot.dnsName}:${config.tailscalePort}`);
      }
      lastConnected = connected;
    } catch (error) {
      console.warn(`pi-web: Tailscale watcher check failed (${firstLine(error)}).`);
    } finally {
      checking = false;
    }
  };
  await check();
  setInterval(() => void check(), 30_000);
}

async function start() {
  const config = loadConfig();
  const existing = runningPid();
  if (existing) {
    console.log(`pi-web: already running (pid ${existing}).`);
    printUrls(config.port, null, config.tailscalePort);
    if (config.tailscale) startTailscaleWatcher();
    if (config.open) openBrowser(`http://${HOST}:${config.port}`);
    return;
  }
  ensureBuilt();
  if (await ping(config.port)) {
    fail(`port ${config.port} is already in use (a \`npm run dev\` server?). Stop it first.`);
  }

  const tailnet = initialTailscaleSetup(config);
  ensureDataDirectory(logPath); // local: create data directory before writing logs.
  const log = fs.openSync(logPath, "a");
  fs.writeSync(log, `\n--- pi-web start ${new Date().toISOString()} ---\n`);
  const child = spawn(process.execPath, [upstreamBin, "-p", config.port, "-H", HOST, "--no-open"], {
    cwd: pkgDir,
    detached: true,
    stdio: ["ignore", log, log],
    env: serverEnv(config, tailnet.dnsName),
  });
  fs.closeSync(log);
  child.unref();
  ensureDataDirectory(pidPath); // local: create data directory before writing pid.
  fs.writeFileSync(pidPath, String(child.pid));

  for (let waited = 0; waited < 60_000; waited += 500) {
    if (!isAlive(child.pid)) fail(`server exited during startup. See \`pi-web logs\`.`);
    if (await ping(config.port)) {
      console.log(`pi-web: running in background (pid ${child.pid}). Stop with \`pi-web stop\`.`);
      printUrls(config.port, tailnet.connected ? tailnet.dnsName : null, config.tailscalePort);
      if (config.tailscale) startTailscaleWatcher();
      if (config.open) openBrowser(`http://${HOST}:${config.port}`);
      return;
    }
    await sleep(500);
  }
  fail(`server did not answer within 60s (pid ${child.pid}). See \`pi-web logs\`.`);
}

async function stop() {
  const config = loadConfig();
  const selection = await runRecordForPort(config.port);
  // Prefer the upstream record: it verifies the process identity and can
  // identify a Next server left behind after its launcher exited.
  const record = selection.record;
  const noServer = selection.error?.startsWith("No pi-web server is running");
  const pid = record?.stopPid ?? (noServer ? runningPid() : null);
  if (!pid) {
    let mapping = "absent";
    if (noServer) {
      const watcherStopped = await stopTailscaleWatcher();
      if (watcherStopped && config.tailscale) mapping = disableTailscale(config);
      if (!watcherStopped) process.exitCode = 1;
    }
    console.log(selection.error && !noServer ? `pi-web: ${selection.error}` : "pi-web: not running.");
    if (mapping === "removed") console.log(`pi-web: removed the leftover Tailscale :${config.tailscalePort} mapping.`);
    if (mapping === "kept") warnKeptMapping(config);
    return;
  }
  // A non-orphan record's detached launcher owns its process group. An
  // orphaned Next process may have been launched in the caller's group, so
  // never signal the launcher's former pid as a process-group id.
  const groupPid = record ? (record.orphaned ? null : record.pid) : pid;
  const signalTarget = (signal) => {
    if (groupPid !== null) {
      try {
        process.kill(-groupPid, signal);
        return;
      } catch {
        // The launcher group may already be gone; try the recorded server pid.
      }
    }
    try {
      process.kill(pid, signal);
    } catch {
      // The caller checks whether it remains alive and reports failure below.
    }
  };
  signalTarget("SIGTERM");
  for (let waited = 0; waited < 10_000 && isAlive(pid); waited += 200) await sleep(200);
  if (isAlive(pid)) {
    signalTarget("SIGKILL");
    for (let waited = 0; waited < 2_000 && isAlive(pid); waited += 200) await sleep(200);
  }
  if (isAlive(pid)) {
    console.error(`pi-web: could not stop pid ${pid}; it is still running or cannot be signalled (permission denied).`);
    process.exitCode = 1;
    return;
  }
  fs.rmSync(pidPath, { force: true });
  if (!(await stopTailscaleWatcher())) {
    process.exitCode = 1;
    return;
  }
  const mapping = config.tailscale ? disableTailscale(config) : "absent";
  console.log(`pi-web: stopped (pid ${pid}).`);
  if (mapping === "kept") warnKeptMapping(config);
}

async function status() {
  const config = loadConfig();
  const selection = await runRecordForPort(config.port);
  const record = selection.record;
  const pid = record?.stopPid ?? (selection.error?.startsWith("No pi-web server is running") ? runningPid() : null);
  const answering = await ping(config.port);
  if (pid) {
    console.log(`pi-web: running in background (pid ${pid}${record?.orphaned ? ", launcher gone" : ""}), ${answering ? "answering" : "not answering yet"}.`);
    printUrls(config.port, null);
  } else if (answering) {
    console.log(`pi-web: not running in background, but port ${config.port} answers (foreground or \`npm run dev\`).`);
  } else {
    console.log("pi-web: not running.");
  }
  const watcherPid = runningWatcherPid();
  console.log(`pi-web: Tailscale watcher ${watcherPid ? `running (pid ${watcherPid})` : "not running"}.`);
  if (config.tailscale) {
    const snapshot = getTailscaleStatus();
    const mapped = isOurServeMapping(config);
    const serverUp = Boolean(pid) || answering;
    const port = `:${config.tailscalePort}`;
    if (snapshot.error) {
      console.log(`Tailscale: ${firstLine(snapshot.error)}`);
    } else if (!snapshot.running) {
      if (serverUp) {
        console.log(watcherPid
          ? "Tailscale: stopped; the watcher connects pi-web when it starts."
          : "Tailscale: stopped; no watcher is running, so pi-web will not connect on its own.");
      } else {
        console.log(mapped
          ? `Tailscale: stopped; a leftover ${port} mapping is kept and is removed by \`pi-web status\` or \`pi-web stop\` once Tailscale runs.`
          : "Tailscale: stopped.");
      }
    } else if (serverUp && mapped && snapshot.dnsName) {
      console.log(`pi-web: https://${snapshot.dnsName}${port} (Tailscale)`);
    } else if (serverUp) {
      console.log(watcherPid
        ? `Tailscale: running; the watcher adds the ${port} mapping within 30 s.`
        : `Tailscale: running, but the ${port} mapping is not active and no watcher is running.`);
    } else if (mapped) {
      const result = disableTailscale(config);
      console.log(result === "removed"
        ? `Tailscale: removed the leftover ${port} mapping (pi-web is not running).`
        : `Tailscale: a leftover ${port} mapping could not be removed.`);
    } else {
      console.log("Tailscale: running; pi-web is not served.");
    }
  }
}

function logs(follow) {
  if (!fs.existsSync(logPath)) {
    console.log(`pi-web: no log yet (${logPath}).`);
    return;
  }
  spawn("tail", follow ? ["-n", "100", "-f", logPath] : ["-n", "100", logPath], { stdio: "inherit" });
}

function foreground() {
  const config = loadConfig();
  ensureBuilt();
  const tailnet = initialTailscaleSetup(config);
  if (config.tailscale) {
    if (tailnet.connected) printUrls(config.port, tailnet.dnsName, config.tailscalePort);
    const interval = setInterval(() => {
      const snapshot = getTailscaleStatus();
      const wasMapped = isOurServeMapping(config);
      const connected = ensureTailscaleMapping(config, snapshot);
      if (connected && snapshot.dnsName && !wasMapped) {
        console.log(`pi-web: Tailscale available at https://${snapshot.dnsName}:${config.tailscalePort}`);
      }
    }, 30_000);
    interval.unref();
    process.on("exit", () => {
      clearInterval(interval);
      disableTailscale(config);
    });
  }
  const env = serverEnv(config, tailnet.dnsName);
  if (config.open) delete env.PI_WEB_NO_OPEN;
  Object.assign(process.env, env);
  const args = process.argv.slice(2);
  if (!args.some((arg) => arg === "-p" || arg.startsWith("--port"))) process.argv.push("-p", config.port);
  require(upstreamBin);
}

function help() {
  const { getHelpText } = require(path.join(pkgDir, "bin", "pi-web-options.js"));
  process.stdout.write(`Usage: pi-web [command] [options]

Commands:
  (none)                     Run in the foreground (logs here, Ctrl+C to stop)
  start, server              Run in the background and open the browser
  stop                       Stop the background server (and Tailscale serve)
  status                     Show whether the server is running
  logs [-f]                  Print the last 100 log lines (-f to follow)
  version, -v, --version     Show the installed version
  open [--port <port>]       Open a running server in the browser
  update --check             Check for an update (never installs)
  help, -h, --help           Show this help

Config file: ${configPath} (migrated automatically from ~/.pi/agent)
  port        Server port (default 30141)
  open        Open the browser on start (default true)
  tailscale   Also serve over Tailscale HTTPS (default false)
  tailscalePort Tailscale HTTPS port (default 8443)
  password    Require this password (sets PI_WEB_PASSWORD)

Background files: ${pidPath}, ${watcherPidPath}, ${logPath} (migrated automatically from ~/.pi/agent)

Foreground options (from the upstream launcher):
`);
  process.stdout.write(getHelpText().replace(/^Usage:.*\n+/, "").replace(/^Start the Pi Web UI server, or run one of the commands below\.\n+/, ""));
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "help" || process.argv.slice(2).some((arg) => arg === "-h" || arg === "--help")) {
    help();
    process.exit(0);
  }
  switch (command) {
    case "start":
    case "server":
      void start();
      break;
    case "stop":
      void stop();
      break;
    case "status":
      void status();
      break;
    case "logs":
      logs(rest.includes("-f") || rest.includes("--follow"));
      break;
    case "version":
    case "-v":
    case "--version":
    case "open":
      forwardUpstream(process.argv.slice(2));
      break;
    case "update":
      if (rest.length === 1 && rest[0] === "--check") {
        forwardUpstream(process.argv.slice(2));
      } else {
        console.error("pi-web: this is a linked local fork; update it with `git fetch upstream && git rebase upstream/main`, then `npm ci && npm run build`.");
        process.exitCode = 1;
      }
      break;
    case "__tailscale-watch":
      void watchTailscale();
      break;
    default:
      foreground();
  }
}

if (require.main === module) main();

module.exports = { dnsNameFromStatus, isServeMappingPresent, parseConfig, parseTailscalePort, piWebDataPath }; // local: expose migration helper for isolated tests.
