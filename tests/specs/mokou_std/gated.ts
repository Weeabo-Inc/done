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
  "assertEquals",
  "deepEquals",
  "expect",
] as const;
for (const name of names) {
  console.log(name, name in Deno);
}
