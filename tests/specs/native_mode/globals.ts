const id = setTimeout(() => {}, 0);
clearTimeout(id);
console.log("setTimeout returns", typeof id);
console.log("process", typeof (globalThis as any).process);
console.log("Buffer", typeof (globalThis as any).Buffer);
console.log("global", typeof (globalThis as any).global);
console.log("setImmediate", typeof (globalThis as any).setImmediate);
