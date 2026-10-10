const names = [
  "openSqlite",
  "password",
  "hash",
  "toml",
  "glob",
  "router",
  "semver",
  "uuid",
  "parseArgs",
  "$",
  "ansi",
  "cookies",
  "json5",
  "S3Client",
  "escapeHTML",
  "markdown",
  "csrf",
  "tar",
  "transpile",
  "secrets",
  "assertEquals",
  "deepEquals",
  "mock",
  "expect",
] as const;
for (const name of names) {
  console.log(name, name in Deno);
}
