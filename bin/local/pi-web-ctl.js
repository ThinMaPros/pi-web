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
// Config: ~/.pi/agent/pi-web.json  { "port", "tailscale", "password", "open" }

/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const configPath = path.join(agentDir, "pi-web.json");
const pidPath = path.join(agentDir, "pi-web.pid");
const logPath = path.join(agentDir, "pi-web.log");
const pkgDir = path.join(__dirname, "..", "..");
const upstreamBin = path.join(pkgDir, "bin", "pi-web.js");
const HOST = "127.0.0.1";

function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") fail(`Cannot read ${configPath}: ${error.message}`);
  }
  return {
    port: String(raw.port ?? process.env.PORT ?? 30141),
    tailscale: raw.tailscale === true,
    password: typeof raw.password === "string" && raw.password ? raw.password : undefined,
    open: raw.open !== false && !/^(1|true|yes|on)$/i.test(process.env.PI_WEB_NO_OPEN ?? "") && !process.argv.includes("--no-open"),
  };
}

function fail(message) {
  console.error(`pi-web: ${message}`);
  process.exit(1);
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runningPid() {
  const pid = readPid();
  if (pid && isAlive(pid)) return pid;
  if (pid) fs.rmSync(pidPath, { force: true });
  return null;
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

/** Returns the MagicDNS hostname once `tailscale serve` proxies HTTPS to the local port. */
function enableTailscale(port) {
  try {
    const status = JSON.parse(tailscale(["status", "--json"]));
    const dnsName = String(status?.Self?.DNSName ?? "").replace(/\.$/, "");
    if (status.BackendState !== "Running" || !dnsName) {
      console.warn("pi-web: Tailscale is not running or not logged in; serving on localhost only.");
      return null;
    }
    tailscale(["serve", "--bg", "--https=443", `http://${HOST}:${port}`]);
    return dnsName;
  } catch (error) {
    console.warn(`pi-web: could not enable Tailscale serve (${firstLine(error)}); serving on localhost only.`);
    return null;
  }
}

function disableTailscale() {
  try {
    tailscale(["serve", "--https=443", "off"]);
  } catch {
    // Nothing was being served, or Tailscale is stopped.
  }
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

function printUrls(port, tailscaleHost) {
  console.log(`pi-web: http://${HOST}:${port}`);
  if (tailscaleHost) console.log(`pi-web: https://${tailscaleHost} (Tailscale)`);
}

function openBrowser(url) {
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
}

// --- Commands --------------------------------------------------------------

async function start() {
  const config = loadConfig();
  const existing = runningPid();
  if (existing) {
    console.log(`pi-web: already running (pid ${existing}).`);
    printUrls(config.port, null);
    if (config.open) openBrowser(`http://${HOST}:${config.port}`);
    return;
  }
  ensureBuilt();
  if (await ping(config.port)) {
    fail(`port ${config.port} is already in use (a \`npm run dev\` server?). Stop it first.`);
  }

  const tailscaleHost = config.tailscale ? enableTailscale(config.port) : null;
  const log = fs.openSync(logPath, "a");
  fs.writeSync(log, `\n--- pi-web start ${new Date().toISOString()} ---\n`);
  const child = spawn(process.execPath, [upstreamBin, "-p", config.port, "-H", HOST, "--no-open"], {
    cwd: pkgDir,
    detached: true,
    stdio: ["ignore", log, log],
    env: serverEnv(config, tailscaleHost),
  });
  child.unref();
  fs.writeFileSync(pidPath, String(child.pid));

  for (let waited = 0; waited < 60_000; waited += 500) {
    if (!isAlive(child.pid)) fail(`server exited during startup. See \`pi-web logs\`.`);
    if (await ping(config.port)) {
      console.log(`pi-web: running in background (pid ${child.pid}). Stop with \`pi-web stop\`.`);
      printUrls(config.port, tailscaleHost);
      if (config.open) openBrowser(`http://${HOST}:${config.port}`);
      return;
    }
    await sleep(500);
  }
  fail(`server did not answer within 60s (pid ${child.pid}). See \`pi-web logs\`.`);
}

async function stop() {
  const config = loadConfig();
  const pid = runningPid();
  if (config.tailscale) disableTailscale();
  if (!pid) {
    console.log("pi-web: not running.");
    return;
  }
  // The launcher runs in its own process group (detached); signal the whole
  // group so Next's server process goes down with it.
  const signalGroup = (signal) => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  };
  signalGroup("SIGTERM");
  for (let waited = 0; waited < 10_000 && isAlive(pid); waited += 200) await sleep(200);
  if (isAlive(pid)) signalGroup("SIGKILL");
  fs.rmSync(pidPath, { force: true });
  console.log(`pi-web: stopped (pid ${pid}).`);
}

async function status() {
  const config = loadConfig();
  const pid = runningPid();
  const answering = await ping(config.port);
  if (pid) {
    console.log(`pi-web: running in background (pid ${pid}), ${answering ? "answering" : "not answering yet"}.`);
    printUrls(config.port, null);
  } else if (answering) {
    console.log(`pi-web: not running in background, but port ${config.port} answers (foreground or \`npm run dev\`).`);
  } else {
    console.log("pi-web: not running.");
  }
  if (config.tailscale) {
    try {
      console.log(tailscale(["serve", "status"]).trim());
    } catch (error) {
      console.log(`Tailscale: ${firstLine(error)}`);
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
  const tailscaleHost = config.tailscale ? enableTailscale(config.port) : null;
  if (tailscaleHost) {
    printUrls(config.port, tailscaleHost);
    process.on("exit", disableTailscale);
  }
  const env = serverEnv(config, tailscaleHost);
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
  help, -h, --help           Show this help

Config file: ${configPath}
  port        Server port (default 30141)
  open        Open the browser on start (default true)
  tailscale   Also serve over Tailscale HTTPS (default false)
  password    Require this password (sets PI_WEB_PASSWORD)

Background files: ${pidPath}, ${logPath}

Foreground options (from the upstream launcher):
`);
  process.stdout.write(getHelpText().replace(/^Usage:.*\n+/, "").replace(/^Start the Pi Web UI server\.\n+/, ""));
}

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
  default:
    foreground();
}
