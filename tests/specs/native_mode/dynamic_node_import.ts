try {
  await import("node:" + "path");
} catch (err) {
  console.log((err as Error).message);
}
