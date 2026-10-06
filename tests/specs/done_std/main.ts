// One end-to-end run through every built-in API.
const flags = Deno.parseArgs(Deno.args, {
  string: ["name"],
  boolean: ["v"],
});
console.log("args:", flags.name, flags.v);

using db = Deno.openSqlite(":memory:");
db.exec("CREATE TABLE users (name TEXT, hash TEXT)");
const hash = await Deno.password.hash("hunter2", {
  memoryCost: 64,
  timeCost: 1,
});
db.run("INSERT INTO users VALUES (?, ?)", "ada", hash);
const row = db.get<{ name: string; hash: string }>("SELECT * FROM users")!;
console.log("sqlite:", row.name);
console.log("password:", await Deno.password.verify("hunter2", row.hash));

console.log("crc32:", Deno.hash.crc32("123456789").toString(16));

const config = Deno.toml.parse(await Deno.readTextFile("data.toml"));
console.log("toml:", config.name, config.server.port);
console.log("yaml:", JSON.stringify(Deno.yaml.parse("a: [1, 2]")));
console.log(
  "csv:",
  JSON.stringify(Deno.csv.parse("a,b\n1,2", { header: true })),
);

console.log("glob:", Deno.globSync("*.toml").join(","));

const handler = Deno.router({
  "GET /hello/:name": (_req, { params }) => new Response(`hi ${params.name}`),
});
const res = await handler(
  new Request("http://localhost/hello/done"),
  {} as Deno.ServeHandlerInfo,
);
console.log("router:", await res.text());

console.log(
  "semver:",
  Deno.semver.maxSatisfying(["1.0.0", "1.4.0", "2.0.0"], "^1"),
);
console.log("uuid:", Deno.uuid.validate(Deno.uuid.v7()));
Deno.expect(1 + 1).toBe(2);
console.log("expect: ok");
