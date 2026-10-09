const files = ["a file.txt", "b.txt"];
await Deno.$`echo ${files}`;
console.log(await Deno.$`echo ${"$HOME; rm -rf /"}`.text());
const { code } = await Deno.$`exit 3`.nothrow();
console.log("exit code", code);
await Deno.$`echo failing >&2 && exit 1`;
