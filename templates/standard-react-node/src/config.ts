export function required(name: string, environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required in the server runtime configuration.`);
  return value;
}
export function readConfig(environment: NodeJS.ProcessEnv = process.env) {
  const origin = required("APP_ORIGIN", environment);
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error("APP_ORIGIN must be an absolute HTTP(S) origin."); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error("APP_ORIGIN must be an HTTP(S) origin without a path, credentials or trailing slash.");
  const port = Number(environment.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");
  return { origin, port, connectionString: required("DATABASE_URL", environment),
    apiKey: required("OPENAI_API_KEY", environment), model: required("OPENAI_MODEL", environment) };
}
