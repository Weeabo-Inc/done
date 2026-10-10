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
  "assertEquals",
  "expect",
] as const;
for (const name of names) {
  console.log(name, name in Deno);
}
