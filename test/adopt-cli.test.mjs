import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../scripts/adopt.mjs", import.meta.url));
const approved = "git+https://github.com/c0x65o/handrail-sdk-ai-assistant-js.git#0123456789abcdef0123456789abcdef01234567";
const fixtures = [];
test.after(() => { for (const path of fixtures) rmSync(path, { recursive: true, force: true }); });

function host() {
  const root = mkdtempSync(join(tmpdir(), "handrail-ai-adopt-"));
  fixtures.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ dependencies: { "@handrail/ai": approved } }, null, 2)}\n`);
  writeFileSync(join(root, "src", "assistant.tsx"), [
    'import { createHandrailAssistant } from "@handrail/ai/server/assistant";',
    'import { usageFromEnvironment } from "@handrail/ai/server/usage-control";',
    'import { HandrailAssistantLauncher } from "@handrail/ai/react/styled";',
    "void createHandrailAssistant; void usageFromEnvironment; void HandrailAssistantLauncher;",
    "const lifecycle = { recoverPendingOnContext: true, flushUsage: true, stopUsageWorker: true };",
    "void lifecycle;",
  ].join("\n"));
  return root;
}

function writeCanonicalLock(root) {
  writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({
    name: "host",
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "@handrail/ai-assistant": approved } },
      "node_modules/@handrail/ai-assistant": { version: "0.2.0", resolved: approved },
    },
  }, null, 2)}\n`);
}

test("migrates the package identity and imports only with --write", () => {
  const root = host();
  execFileSync(process.execPath, [cli, "migrate-package", root, "--write"]);
  writeCanonicalLock(root);
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"))).dependencies["@handrail/ai-assistant"], approved);
  assert.doesNotMatch(readFileSync(join(root, "src", "assistant.tsx"), "utf8"), /@handrail\/ai(?:["/])/u);
  assert.equal(spawnSync(process.execPath, [cli, "check", root]).status, 0);
});

test("scaffolds the standard server and styled client only into an empty target", () => {
  const parent = mkdtempSync(join(tmpdir(), "handrail-ai-scaffold-"));
  fixtures.push(parent);
  const target = join(parent, "assistant");
  execFileSync(process.execPath, [cli, "scaffold", target, "--sdk-revision", approved.split("#")[1]]);
  expectFile(join(target, "src/assistant/server.ts"), "createHandrailAssistant");
  expectFile(join(target, "src/assistant/client.tsx"), "HandrailAssistantLauncher");
  expectFile(join(target, "src/assistant/host/identity.ts"), "host_auth_not_configured");
  expectFile(join(target, "src/migrate.ts"), "persistence.migrate");
  expectFile(join(target, ".npmrc"), "allow-git=root");
  expectFile(join(target, ".gitignore"), "node_modules/");
  assert.equal(JSON.parse(readFileSync(join(target, "package.json"))).dependencies["@handrail/ai-assistant"], approved);
  assert.equal(JSON.parse(readFileSync(join(target, "package.json"))).allowScripts[approved], true);
  writeFileSync(join(target, "owned.txt"), "keep");
  assert.notEqual(spawnSync(process.execPath, [cli, "scaffold", target]).status, 0);
});

test("rejects a branch/tag/partial scaffold revision before writing files", () => {
  const parent = mkdtempSync(join(tmpdir(), "handrail-ai-scaffold-revision-")); fixtures.push(parent);
  for (const revision of ['main', 'v0.2.35', '5d9387c', '../unsafe']) {
    const result = spawnSync(process.execPath, [cli, "scaffold", join(parent, 'target'), '--sdk-revision', revision], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /full lowercase 40-character Git SHA/);
  }
});

test("rejects a mismatched, missing, linked or non-Git resolved SDK even when the lock root matches", () => {
  const root = host(); execFileSync(process.execPath, [cli, 'migrate-package', root, '--write']);
  for (const change of [
    { resolved: approved.replace('0123456789abcdef0123456789abcdef01234567', 'f'.repeat(40)) },
    { resolved: undefined }, { resolved: 'https://registry.npmjs.org/example/-/example.tgz' },
    { resolved: 'file:../local-sdk' }, { link: true }, { version: '0.1.99' },
  ]) {
    writeCanonicalLock(root);
    const path = join(root, 'package-lock.json'), lock = JSON.parse(readFileSync(path));
    Object.assign(lock.packages['node_modules/@handrail/ai-assistant'], change);
    writeFileSync(path, JSON.stringify(lock));
    const result = spawnSync(process.execPath, [cli, 'check', root], { encoding: 'utf8' });
    assert.equal(result.status, 1, JSON.stringify(change));
    assert.equal(JSON.parse(result.stdout).findings.find(item => item.id === 'lockfile').ok, false);
    assert.equal(JSON.parse(result.stdout).qualification, 'static-source-and-lockfile-only');
  }
});

test("rejects conflicting dependency groups and nested legacy or duplicate SDK lock nodes", () => {
  const root = host(); execFileSync(process.execPath, [cli, 'migrate-package', root, '--write']);
  const manifestPath = join(root, 'package.json');
  const canonical = JSON.parse(readFileSync(manifestPath));
  for (const scenario of ['group', 'legacy', 'duplicate']) {
    writeCanonicalLock(root); writeFileSync(manifestPath, JSON.stringify(canonical));
    const path = join(root, 'package-lock.json'), lock = JSON.parse(readFileSync(path));
    if (scenario === 'group') {
      const changed = { ...canonical, devDependencies: { '@handrail/ai-assistant': 'file:../sdk' } };
      writeFileSync(manifestPath, JSON.stringify(changed));
      lock.packages[''].devDependencies = changed.devDependencies;
    } else {
      lock.packages[`node_modules/host/node_modules/@handrail/${scenario === 'legacy' ? 'ai' : 'ai-assistant'}`] =
        { version: '0.2.0', resolved: approved };
    }
    writeFileSync(path, JSON.stringify(lock));
    const result = spawnSync(process.execPath, [cli, 'check', root], { encoding: 'utf8' });
    assert.equal(result.status, 1, scenario);
    assert.equal(JSON.parse(result.stdout).findings.find(item => item.id === 'lockfile').ok, false);
  }
});

function expectFile(path, content) {
  assert.match(readFileSync(path, "utf8"), new RegExp(content, "u"));
}

test("fails conformance for an unpinned or incomplete host", () => {
  const root = host();
  writeFileSync(join(root, "package.json"), '{"dependencies":{"@handrail/ai-assistant":"latest"}}\n');
  assert.equal(spawnSync(process.execPath, [cli, "check", root]).status, 1);
});

for (const stopMethod of ["stopUsageWorker", "stopBackgroundWorkers"]) test(`accepts the shared workspace with ${stopMethod}`, () => {
  const root = host();
  execFileSync(process.execPath, [cli, "migrate-package", root, "--write"]);
  writeCanonicalLock(root);
  const path = join(root, "src", "assistant.tsx");
  writeFileSync(path, readFileSync(path, "utf8").replaceAll("HandrailAssistantLauncher", "HandrailAssistantWorkspace")
    .replaceAll("stopUsageWorker", stopMethod));
  const result = spawnSync(process.execPath, [cli, "check", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).findings.find(finding => finding.id === "ui").ok, true);
});
