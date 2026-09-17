// Compile a consumer's real integration sources against this SDK's built public
// declarations. This is source qualification only: no installation, dependency
// declaration, lockfile, symlink, or consumer configuration is changed.
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const [project, configName, ...entries] = process.argv.slice(2);
if (!project || !configName || !entries.length) {
  throw new Error('Usage: node scripts/check-consumer-contracts.mjs PROJECT_ROOT TSCONFIG ENTRY [ENTRY ...]');
}
const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = resolve(project), configPath = resolve(projectRoot, configName);
const manifest = JSON.parse(readFileSync(resolve(sdkRoot, 'package.json'), 'utf8'));
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
const paths = { ...parsed.options.paths };
for (const [key, value] of Object.entries(manifest.exports)) {
  if (value.types) paths[manifest.name + (key === '.' ? '' : key.slice(1))] = [resolve(sdkRoot, value.types)];
}
const options = { ...parsed.options, noEmit: true, incremental: false, composite: false, paths };
const rootNames = [...new Set([
  ...entries.map(entry => isAbsolute(entry) ? entry : resolve(projectRoot, entry)),
  ...parsed.fileNames.filter(file => file.endsWith('.d.ts')),
])];
const host = ts.createCompilerHost(options);
host.getCurrentDirectory = () => projectRoot;
const started = performance.now();
const program = ts.createProgram({ rootNames, options, host });
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
const errors = diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
const report = { projectRoot, config: configName, sdkVersion: manifest.version,
  qualification: 'local built declarations; installed Git dependency unchanged',
  roots: entries, sourceFiles: program.getSourceFiles().length, errors: errors.length,
  milliseconds: Math.round(performance.now() - started), rssBytes: process.memoryUsage().rss };
if (diagnostics.length) process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory: () => projectRoot, getCanonicalFileName: file => file, getNewLine: () => '\n',
}));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (errors.length) process.exitCode = 1;
