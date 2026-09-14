#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PACKAGE = "@handrail/ai-assistant";
const LEGACY_PACKAGE = "@handrail/ai";
const DEPENDENCY_GROUPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const SOURCE_PATTERN = /^git\+https:\/\/github\.com\/c0x65o\/handrail-sdk-ai-assistant-js\.git#[0-9a-f]{40}$/u;
const TEXT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const LEGACY_IMPORT_PATTERN = /@handrail\/ai(?=\/|["'])/u;
const LEGACY_IMPORT_REPLACEMENT_PATTERN = /@handrail\/ai(?=\/|["'])/gu;
const RELEASE_VERSION_PATTERN = /^(?:0\.(?:[2-9]|[1-9]\d+)\.\d+|[1-9]\d*\.\d+\.\d+)(?:[-+].*)?$/u;
const TEMPLATE_ROOT = fileURLToPath(new URL("../templates/standard-react-node", import.meta.url));
const SDK_REPOSITORY = "https://github.com/c0x65o/handrail-sdk-ai-assistant-js.git";

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: handrail-ai-assistant <check|migrate-package> <directory> [--write]\n       handrail-ai-assistant scaffold <empty-directory> [--sdk-revision <full-sha>]");
  process.exit(2);
}

function extension(path) {
  const match = /(?:\.[^./]+)$/u.exec(path);
  return match?.[0] ?? "";
}

function sourceFiles(root) {
  const start = join(root, "src");
  if (!existsSync(start)) return [];
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      if (["node_modules", "dist", "build", ".git"].includes(entry)) continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (TEXT_EXTENSIONS.has(extension(path))) found.push(path);
    }
  };
  visit(start);
  return found;
}

function manifestAt(root) {
  const path = join(root, "package.json");
  if (!existsSync(path)) usage(`No package.json exists under ${root}`);
  return { path, value: JSON.parse(readFileSync(path, "utf8")) };
}

function dependency(manifest, name) {
  for (const group of DEPENDENCY_GROUPS) {
    if (manifest[group]?.[name]) return { group, source: manifest[group][name] };
  }
  return null;
}

function inspect(root) {
  const { value: manifest } = manifestAt(root);
  const files = sourceFiles(root);
  const source = files.map((path) => readFileSync(path, "utf8")).join("\n");
  const importsSdkPath = (path) => source.includes(`${PACKAGE}/${path}`) ||
    source.includes(`${LEGACY_PACKAGE}/${path}`);
  const current = dependency(manifest, PACKAGE);
  const legacy = dependency(manifest, LEGACY_PACKAGE);
  const standardUi = importsSdkPath("react/styled") &&
    (source.includes("HandrailAssistantLauncher") || source.includes("HandrailAssistantWorkspace"));
  const explicitHeadless = importsSdkPath("react/headless");
  const lockPath = join(root, "package-lock.json");
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;
  const locked = lock?.packages?.[`node_modules/${PACKAGE}`];
  const legacyLocked = Object.keys(lock?.packages ?? {}).some((path) => path.endsWith(`node_modules/${LEGACY_PACKAGE}`));
  const canonicalNodes = Object.keys(lock?.packages ?? {}).filter((path) => path.endsWith(`node_modules/${PACKAGE}`));
  const sourcesMatch = current && DEPENDENCY_GROUPS.every((group) => !manifest[group]?.[PACKAGE] ||
    (manifest[group][PACKAGE] === current.source && lock?.packages?.[""]?.[group]?.[PACKAGE] === current.source));
  const lockCurrentSource = current ? lock?.packages?.[""]?.[current.group]?.[PACKAGE] : undefined;
  const lockMatches = Boolean(lock && locked && RELEASE_VERSION_PATTERN.test(locked.version ?? "")
    && !locked.link && SOURCE_PATTERN.test(locked.resolved ?? "")
    && locked.resolved === current?.source && lockCurrentSource === current?.source && !legacyLocked
    && sourcesMatch && canonicalNodes.length === 1);
  const recovery = source.includes("flushUsage") && source.includes("stopUsageWorker") &&
    (source.includes("recoverPendingOnContext") ||
      (source.includes("recoveryContexts") && source.includes("recoverPending")));
  const findings = [
    { id: "package", ok: Boolean(current), detail: current ? `${current.group}: ${current.source}` : `${PACKAGE} is missing` },
    { id: "immutable-source", ok: Boolean(current && SOURCE_PATTERN.test(current.source)), detail: current && SOURCE_PATTERN.test(current.source) ? "full immutable Git SHA" : "dependency must use the approved Git URL and a full SHA" },
    { id: "lockfile", ok: lockMatches, detail: lockMatches ? `${locked.version}, resolved Git SHA and identity match` : "package-lock must resolve one canonical package at version 0.2.0 or newer from the exact manifest Git URL/SHA in every dependency group, with no legacy, duplicate or linked node" },
    { id: "legacy-package-removed", ok: !legacy && !LEGACY_IMPORT_PATTERN.test(source), detail: !legacy && !LEGACY_IMPORT_PATTERN.test(source) ? "no legacy dependency/imports" : `${LEGACY_PACKAGE} remains` },
    { id: "high-level-server", ok: importsSdkPath("server/assistant") && source.includes("createHandrailAssistant"), detail: "standard server assembly" },
    { id: "telemetry", ok: importsSdkPath("server/usage-control") && source.includes("usageFromEnvironment"), detail: "automatic Handrail usage binding" },
    { id: "recovery", ok: recovery, detail: recovery
      ? "trusted-context or startup recovery plus graceful shutdown"
      : "configure trusted-context recovery or recoveryContexts, then flush and stop usage on shutdown" },
    { id: "ui", ok: standardUi || explicitHeadless, detail: standardUi ? "standard styled assistant" : explicitHeadless ? "explicit headless integration" : "use HandrailAssistantLauncher, HandrailAssistantWorkspace, or explicitly select react/headless" },
  ];
  return { schemaVersion: 1, qualification: "static-source-and-lockfile-only", package: PACKAGE, host: basename(root), root, passed: findings.every((item) => item.ok), findings };
}

function scaffold(target, frozenRevision) {
  if (!existsSync(TEMPLATE_ROOT)) throw new Error(`Packaged template is missing: ${TEMPLATE_ROOT}`);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`Scaffold target must be absent or empty: ${target}`);
  }
  if (frozenRevision !== undefined && !/^[0-9a-f]{40}$/u.test(frozenRevision)) throw new TypeError("--sdk-revision requires a full lowercase 40-character Git SHA.");
  // New installs resolve public HEAD once, then freeze it in the manifest.
  // An explicit frozen upgrade revision is never replaced with a newer one.
  const revision = frozenRevision ?? execFileSync("git", ["ls-remote", "--exit-code", SDK_REPOSITORY, "HEAD"],
    { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim().split(/\s+/u)[0];
  if (!/^[0-9a-f]{40}$/u.test(revision ?? "")) throw new Error("Could not resolve a committed public SDK revision. No scaffold was written.");
  mkdirSync(target, { recursive: true });
  const created = [];
  const copy = (sourceDirectory, targetDirectory) => {
    mkdirSync(targetDirectory, { recursive: true });
    for (const entry of readdirSync(sourceDirectory)) {
      const sourcePath = join(sourceDirectory, entry);
      const targetPath = join(targetDirectory, entry === "npmrc.template" ? ".npmrc" : entry === "gitignore.template" ? ".gitignore" : entry);
      if (statSync(sourcePath).isDirectory()) copy(sourcePath, targetPath);
      else {
        mkdirSync(dirname(targetPath), { recursive: true });
        copyFileSync(sourcePath, targetPath);
        created.push(targetPath);
      }
    }
  };
  copy(TEMPLATE_ROOT, target);
  const manifestPath = join(target, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies[PACKAGE] = `git+${SDK_REPOSITORY}#${revision}`;
  // npm 12 matches Git build permissions by resolved source, not package name.
  manifest.allowScripts = { ...manifest.allowScripts, [manifest.dependencies[PACKAGE]]: true };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { schemaVersion: 1, action: "scaffold", target, sdkRevision: revision, installed: false,
    next: ["npm install --include=dev", "npm run check", "Connect src/assistant/host/identity.ts to trusted application authentication", "Configure declared server environment; run npm run doctor", "Apply SDK migrations through the authorized database workflow"], created };
}

function migrate(root, write) {
  const { path, value: manifest } = manifestAt(root);
  let changed = false;
  for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (!manifest[group]?.[LEGACY_PACKAGE]) continue;
    if (manifest[group][PACKAGE] && manifest[group][PACKAGE] !== manifest[group][LEGACY_PACKAGE]) {
      throw new Error(`${group} already contains a conflicting ${PACKAGE} dependency`);
    }
    manifest[group][PACKAGE] = manifest[group][LEGACY_PACKAGE];
    delete manifest[group][LEGACY_PACKAGE];
    changed = true;
  }
  const replacements = [];
  for (const sourcePath of sourceFiles(root)) {
    const before = readFileSync(sourcePath, "utf8");
    const after = before.replace(LEGACY_IMPORT_REPLACEMENT_PATTERN, PACKAGE);
    if (before === after) continue;
    replacements.push(sourcePath);
    if (write) writeFileSync(sourcePath, after);
  }
  if (write && changed) writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return { schemaVersion: 1, action: "migrate-package", write, root, manifestChanged: changed, sourceFiles: replacements };
}

const [command, directory, ...flags] = process.argv.slice(2);
if (!command || !directory) usage();
if (command !== "scaffold" && flags.some((flag) => flag !== "--write")) usage();
const root = resolve(directory);
if (command === "check") {
  const result = inspect(root);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}
if (command === "migrate-package") {
  console.log(JSON.stringify(migrate(root, flags.includes("--write")), null, 2));
  process.exit(0);
}
if (command === "scaffold") {
  if (flags.length && (flags.length !== 2 || flags[0] !== "--sdk-revision")) usage("scaffold accepts only --sdk-revision <full-sha>");
  console.log(JSON.stringify(scaffold(root, flags[1]), null, 2));
  process.exit(0);
}
usage(`Unknown command: ${command}`);
