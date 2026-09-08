export function resolve(specifier, context, nextResolve) {
  if (/^(?:react-markdown|remark-gfm)(?:\/|$)/u.test(specifier)) {
    throw new Error(`Unexpected Markdown UI dependency: ${specifier}`);
  }
  return nextResolve(specifier, context);
}
