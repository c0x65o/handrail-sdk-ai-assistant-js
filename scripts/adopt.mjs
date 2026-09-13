#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "@handrail/ai-assistant";
const LEGACY_PACKAGE = "@handrail/ai";
const SOURCE_PATTERN = /^git\+https:\/\/github\.com\/c0x65o\/handrail-sdk-ai-assistant-js\.git#[0-9a-f]{40}$/u;
const TEXT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const LEGACY_IMPORT_PATTERN = /@handrail\/ai(?=\/|["'])/u;
const LEGACY_IMPORT_REPLACEMENT_PATTERN = /@handrail\/ai(?=\/|["'])/gu;
const RELEASE_VERSION_PATTERN = /^(?:0\.(?:[2-9]|[1-9]\d+)\.\d+|[1-9]\d*\.\d+\.\d+)(?:[-+].*)?$/u;
const TEMPLATE_ROOT = fileURLToPath(new URL("../templates/standard-react-node", import.meta.url));

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: handrail-ai-assistant <check|migrate-package|scaffold> <directory> [--write]");
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
  for (const group of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
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
  const standardUi = importsSdkPath("react/styled") && source.includes("HandrailAssistantLauncher");
  const explicitHeadless = importsSdkPath("react/headless");
  const lockPath = join(root, "package-lock.json");
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;
  const locked = lock?.packages?.[`node_modules/${PACKAGE}`];
  const legacyLocked = lock?.packages?.[`node_modules/${LEGACY_PACKAGE}`];
  const lockCurrentSource = lock?.packages?.[""]?.dependencies?.[PACKAGE]
    ?? lock?.packages?.[""]?.devDependencies?.[PACKAGE];
  const lockMatches = Boolean(lock && locked && RELEASE_VERSION_PATTERN.test(locked.version ?? "")
    && lockCurrentSource === current?.source && !legacyLocked);
  const recovery = source.includes("flushUsage") && source.includes("stopUsageWorker") &&
    (source.includes("recoverPendingOnContext") ||
      (source.includes("recoveryContexts") && source.includes("recoverPending")));
  const findings = [
    { id: "package", ok: Boolean(current), detail: current ? `${current.group}: ${current.source}` : `${PACKAGE} is missing` },
    { id: "immutable-source", ok: Boolean(current && SOURCE_PATTERN.test(current.source)), detail: current && SOURCE_PATTERN.test(current.source) ? "full immutable Git SHA" : "dependency must use the approved Git URL and a full SHA" },
    { id: "lockfile", ok: lockMatches, detail: lockMatches ? `${locked.version}, source and identity match` : "package-lock must resolve the canonical package at version 0.2.0 or newer from the manifest source, with no legacy node" },
    { id: "legacy-package-removed", ok: !legacy && !LEGACY_IMPORT_PATTERN.test(source), detail: !legacy && !LEGACY_IMPORT_PATTERN.test(source) ? "no legacy dependency/imports" : `${LEGACY_PACKAGE} remains` },
    { id: "high-level-server", ok: importsSdkPath("server/assistant") && source.includes("createHandrailAssistant"), detail: "standard server assembly" },
    { id: "telemetry", ok: importsSdkPath("server/usage-control") && source.includes("usageFromEnvironment"), detail: "automatic Handrail usage binding" },
    { id: "recovery", ok: recovery, detail: recovery
      ? "trusted-context or startup recovery plus graceful shutdown"
      : "configure trusted-context recovery or recoveryContexts, then flush and stop usage on shutdown" },
    { id: "ui", ok: standardUi || explicitHeadless, detail: standardUi ? "standard styled launcher" : explicitHeadless ? "explicit headless integration" : "use HandrailAssistantLauncher or explicitly select react/headless" },
  ];
  return { schemaVersion: 1, package: PACKAGE, host: basename(root), root, passed: findings.every((item) => item.ok), findings };
}

function scaffold(target) {
  if (!existsSync(TEMPLATE_ROOT)) throw new Error(`Packaged template is missing: ${TEMPLATE_ROOT}`);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`Scaffold target must be absent or empty: ${target}`);
  }
  mkdirSync(target, { recursive: true });
  const created = [];
  const copy = (sourceDirectory, targetDirectory) => {
    mkdirSync(targetDirectory, { recursive: true });
    for (const entry of readdirSync(sourceDirectory)) {
      const sourcePath = join(sourceDirectory, entry);
      const targetPath = join(targetDirectory, entry);
      if (statSync(sourcePath).isDirectory()) copy(sourcePath, targetPath);
      else {
        mkdirSync(dirname(targetPath), { recursive: true });
        copyFileSync(sourcePath, targetPath);
        created.push(targetPath);
      }
    }
  };
  copy(TEMPLATE_ROOT, target);
  return { schemaVersion: 1, action: "scaffold", target, created };
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
if (!command || !directory || flags.some((flag) => flag !== "--write")) usage();
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
  if (flags.length > 0) usage("scaffold does not accept flags");
  console.log(JSON.stringify(scaffold(root), null, 2));
  process.exit(0);
}
usage(`Unknown command: ${command}`);
