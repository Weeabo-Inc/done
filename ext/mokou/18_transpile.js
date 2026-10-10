// Copyright 2018-2026 the Deno authors. MIT license.

// `Deno.transpile()`: TypeScript and JSX to JavaScript.

(function () {
const { core, primordials } = __bootstrap;
const { op_done_transpile } = core.ops;
const { TypeError } = primordials;

function transpile(source, options = { __proto__: null }) {
  if (typeof source !== "string") {
    throw new TypeError("Source to transpile must be a string");
  }
  const jsx = options.jsx ?? { __proto__: null };
  return op_done_transpile(source, {
    loader: options.loader,
    filename: options.filename === undefined
      ? undefined
      : `${options.filename}`,
    jsx: {
      runtime: jsx.runtime,
      importSource: jsx.importSource,
      factory: jsx.factory,
      fragmentFactory: jsx.fragmentFactory,
      development: !!jsx.development,
    },
    decorators: options.decorators,
    sourceMap: options.sourceMap,
    removeComments: !!options.removeComments,
    verbatimModuleSyntax: !!options.verbatimModuleSyntax,
  });
}

return { transpile };
})();
