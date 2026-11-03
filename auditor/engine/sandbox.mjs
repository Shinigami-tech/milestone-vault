// Starts one throwaway sandbox per task and destroys it afterwards.
// Containment layer 1 (the container): no secrets, non-root, read-only filesystem, no Linux capabilities,
// CPU / memory / process / time limits, removed with --rm after every run.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const DRIVER = process.env.SD_DRIVER || "docker"; // "docker" (production) or "local" (development only)
const IMAGE = process.env.SD_IMAGE || "mv-auditor-sandbox";
const LIMITS = { memory: "1g", cpus: "1", pids: "512", seconds: 75 };

export const CONTAINMENT_POLICY = [
  { id: "isolation", label: "Fresh container per task, destroyed after", flag: "--rm" },
  { id: "secrets", label: "No API keys or env secrets inside", flag: "clean env" },
  { id: "root", label: "Runs as unprivileged user", flag: "USER pwuser" },
  { id: "fs", label: "Read-only filesystem", flag: "--read-only" },
  { id: "caps", label: "All Linux capabilities dropped", flag: "--cap-drop ALL" },
  { id: "limits", label: `Capped at ${LIMITS.memory} RAM, ${LIMITS.cpus} CPU, ${LIMITS.pids} processes, ${LIMITS.seconds}s`, flag: "--memory --cpus --pids-limit" },
  { id: "network", label: "Browser blocks metadata, private network and data exfiltration", flag: "network guard" },
];

export async function runSandbox({ url, mode, patch, workDir, allowHosts = [], onLog = () => {} }) {
  const id = "sd-" + randomBytes(4).toString("hex");
  const dir = join(workDir, `${mode}-${id}`);
  mkdirSync(join(dir, "out"), { recursive: true });
  chmodSync(join(dir, "out"), 0o777); // the sandbox user (uid 1001) may write ONLY here
  writeFileSync(join(dir, "input.json"), JSON.stringify({ url, mode, patch, allowHosts }));

  let cmd, args, env;
  if (DRIVER === "local") {
    cmd = process.execPath;
    args = [new URL("../sandbox/runner.mjs", import.meta.url).pathname];
    env = { PATH: process.env.PATH, HOME: process.env.HOME, SD_JOB_DIR: dir };
  } else {
    cmd = "docker";
    args = [
      "run", "--rm", "--name", id,
      "--read-only", "--tmpfs", "/tmp:rw,size=256m", "--tmpfs", "/home/pwuser:rw,size=128m",
      "--memory", LIMITS.memory, "--memory-swap", LIMITS.memory, "--cpus", LIMITS.cpus, "--pids-limit", LIMITS.pids,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "-e", "HOME=/home/pwuser",
      "-v", `${join(dir, "input.json")}:/job/input.json:ro`,
      "-v", `${join(dir, "out")}:/job/out:rw`,
      IMAGE,
    ];
    env = { PATH: process.env.PATH }; // nothing else from the host leaks in
  }

  const t0 = Date.now();
  onLog(`Sandbox ${id} started (${DRIVER === "docker" ? "isolated container" : "local dev mode"})`);
  await new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const killer = setTimeout(() => {
      onLog(`Sandbox ${id} exceeded ${LIMITS.seconds}s, killing it`);
      if (DRIVER === "docker") spawn("docker", ["kill", id]); else child.kill("SIGKILL");
    }, LIMITS.seconds * 1000);
    const pipe = (buf) => String(buf).split("\n").filter(Boolean).forEach((l) => onLog(l.replace(/^\[sandbox\]\s*/, "")));
    child.stdout.on("data", pipe);
    child.stderr.on("data", (b) => pipe(String(b).slice(0, 500)));
    child.on("close", () => { clearTimeout(killer); resolve(); });
    child.on("error", (e) => { clearTimeout(killer); onLog(`Could not start sandbox: ${e.message}`); resolve(); });
  });
  onLog(`Sandbox ${id} destroyed after ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const reportPath = join(dir, "out", "report.json");
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : { ok: false, error: "Sandbox produced no report" };
  return { id, dir, report, seconds: (Date.now() - t0) / 1000 };
}
