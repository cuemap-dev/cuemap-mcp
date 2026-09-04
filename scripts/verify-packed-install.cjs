const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const packageRoot = resolve(__dirname, "..");
const sdkRoot = resolve(packageRoot, "../typescript-sdk");
const mcpPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const sdkPackage = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
const sandbox = mkdtempSync(join(tmpdir(), "cuemap-mcp-pack-"));

try {
    execFileSync("npm", ["pack", "--pack-destination", sandbox], { cwd: packageRoot, stdio: "inherit" });
    const tarball = join(sandbox, `${mcpPackage.name}-${mcpPackage.version}.tgz`);
    execFileSync("npm", ["pack", "--pack-destination", sandbox], { cwd: sdkRoot, stdio: "inherit" });
    const sdkTarball = join(sandbox, `${sdkPackage.name}-${sdkPackage.version}.tgz`);
    execFileSync("npm", ["init", "-y"], { cwd: sandbox, stdio: "ignore" });
    execFileSync("npm", ["install", "--ignore-scripts", "--no-save", sdkTarball, tarball], { cwd: sandbox, stdio: "inherit" });
    const probe = [
        "const fs = require('node:fs'); const path = require('node:path');",
        "const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve('cuemap-mcp')), '..', 'package.json')));",
        `if (pkg.version !== ${JSON.stringify(mcpPackage.version)}) throw new Error('unexpected package version');`,
        "if (!fs.existsSync(require.resolve('cuemap-mcp/build/index.js'))) throw new Error('MCP entry point missing');",
        "if (!fs.existsSync(path.join(path.dirname(require.resolve('cuemap-mcp')), '..', 'SKILL.md'))) throw new Error('MCP SKILL.md missing from package');",
    ].join(" ");
    execFileSync(process.execPath, ["-e", probe], { cwd: sandbox, stdio: "inherit" });
    assert.ok(true);
    console.log("verified the packed MCP server in a fresh npm project");
} finally {
    rmSync(sandbox, { recursive: true, force: true });
}
