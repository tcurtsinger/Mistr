import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scanner = resolve("scripts/check-public-repo.ps1");

describe("public repository scanner", () => {
  it("rejects a PuTTY private-key payload", () => {
    const payload = [
      `Pu${"TTY"}-User-Key-File-3: ssh-ed25519`,
      "Encryption: none",
      "Comment: scanner probe",
      "Public-Lines: 1",
      "AAAA",
      "Private-Lines: 1",
      "BBBB",
    ].join("\n");
    expectRejected(payload);
  }, 30_000);

  it("rejects temporary AWS access keys and session-token fields", () => {
    const accessKey = `AS${"IA"}${"A".repeat(16)}`;
    const sessionField = `aws_session_${"token"}`;
    expectRejected(`${accessKey}\n${sessionField}=${"B".repeat(32)}\n`);
  }, 30_000);
});

function expectRejected(content) {
  const probe = resolve(`public-check-probe-${process.pid}-${Date.now()}.txt`);
  try {
    writeFileSync(probe, content);
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", scanner,
    ], { cwd: resolve("."), encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("possible secret pattern");
  } finally {
    try { unlinkSync(probe); } catch { /* Probe may already be absent. */ }
  }
}
