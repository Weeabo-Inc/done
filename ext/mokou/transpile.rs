// Copyright 2018-2026 the Deno authors. MIT license.

//! `Deno.transpile()`: TypeScript and JSX to JavaScript, with the same
//! compiler (swc, through deno_ast) that runs Mokou's own modules.

use deno_ast::DecoratorsTranspileOption;
use deno_ast::EmitOptions;
use deno_ast::ImportsNotUsedAsValues;
use deno_ast::JsxAutomaticOptions;
use deno_ast::JsxClassicOptions;
use deno_ast::JsxPrecompileOptions;
use deno_ast::JsxRuntime;
use deno_ast::MediaType;
use deno_ast::ParseParams;
use deno_ast::SourceMapOption;
use deno_ast::TranspileModuleOptions;
use deno_ast::TranspileOptions;
use deno_core::op2;
use deno_core::url::Url;
use deno_error::JsErrorBox;
use serde::Deserialize;
use serde::Serialize;

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Options {
  loader: Option<String>,
  filename: Option<String>,
  jsx: JsxOptions,
  decorators: Option<String>,
  source_map: Option<String>,
  remove_comments: bool,
  verbatim_module_syntax: bool,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct JsxOptions {
  runtime: Option<String>,
  import_source: Option<String>,
  factory: Option<String>,
  fragment_factory: Option<String>,
  development: bool,
}

#[derive(Serialize)]
pub struct Output {
  code: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  map: Option<String>,
}

fn specifier(filename: Option<&str>) -> Result<Url, JsErrorBox> {
  let Some(filename) = filename else {
    return Ok(Url::parse("file:///input.ts").unwrap());
  };
  if let Ok(url) = Url::parse(filename)
    && url.scheme().len() > 1
  {
    return Ok(url);
  }
  let base = Url::parse("file:///").unwrap();
  let path = filename.replace('\\', "/");
  base
    .join(&path)
    .map_err(|e| JsErrorBox::type_error(format!("Invalid filename: {e}")))
}

fn media_type(loader: &str) -> Result<MediaType, JsErrorBox> {
  Ok(match loader {
    "ts" => MediaType::TypeScript,
    "tsx" => MediaType::Tsx,
    "mts" => MediaType::Mts,
    "cts" => MediaType::Cts,
    "js" => MediaType::JavaScript,
    "jsx" => MediaType::Jsx,
    "mjs" => MediaType::Mjs,
    "cjs" => MediaType::Cjs,
    _ => {
      return Err(JsErrorBox::type_error(format!(
        "Unsupported loader \"{loader}\"; expected \"ts\", \"tsx\", \"mts\", \"cts\", \"js\", \"jsx\", \"mjs\" or \"cjs\""
      )));
    }
  })
}

fn jsx(options: JsxOptions) -> Result<JsxRuntime, JsErrorBox> {
  let automatic = || JsxAutomaticOptions {
    development: options.development,
    import_source: options.import_source.clone(),
  };
  Ok(match options.runtime.as_deref().unwrap_or("classic") {
    "classic" => {
      let defaults = JsxClassicOptions::default();
      JsxRuntime::Classic(JsxClassicOptions {
        factory: options.factory.clone().unwrap_or(defaults.factory),
        fragment_factory: options
          .fragment_factory
          .clone()
          .unwrap_or(defaults.fragment_factory),
      })
    }
    "automatic" => JsxRuntime::Automatic(automatic()),
    "precompile" => JsxRuntime::Precompile(JsxPrecompileOptions {
      automatic: automatic(),
      skip_elements: None,
      dynamic_props: None,
    }),
    other => {
      return Err(JsErrorBox::type_error(format!(
        "Unsupported JSX runtime \"{other}\"; expected \"classic\", \"automatic\" or \"precompile\""
      )));
    }
  })
}

pub fn transpile(
  source: String,
  options: Options,
) -> Result<Output, JsErrorBox> {
  let specifier = specifier(options.filename.as_deref())?;
  let media_type = match options.loader.as_deref() {
    Some(loader) => media_type(loader)?,
    None if options.filename.is_some() => {
      match MediaType::from_specifier(&specifier) {
        MediaType::Unknown => MediaType::TypeScript,
        media_type => media_type,
      }
    }
    None => MediaType::TypeScript,
  };
  let decorators = match options.decorators.as_deref().unwrap_or("tc39") {
    "tc39" => DecoratorsTranspileOption::Ecma,
    "legacy" => DecoratorsTranspileOption::LegacyTypeScript {
      emit_metadata: false,
    },
    other => {
      return Err(JsErrorBox::type_error(format!(
        "Unsupported decorators \"{other}\"; expected \"tc39\" or \"legacy\""
      )));
    }
  };
  let source_map = match options.source_map.as_deref().unwrap_or("none") {
    "none" => SourceMapOption::None,
    "inline" => SourceMapOption::Inline,
    "external" => SourceMapOption::Separate,
    other => {
      return Err(JsErrorBox::type_error(format!(
        "Unsupported sourceMap \"{other}\"; expected \"none\", \"inline\" or \"external\""
      )));
    }
  };
  let jsx = jsx(options.jsx)?;

  let parsed = deno_ast::parse_module(ParseParams {
    specifier,
    text: source.into(),
    media_type,
    capture_tokens: false,
    scope_analysis: false,
    maybe_syntax: None,
  })
  .map_err(|e| JsErrorBox::new("SyntaxError", e.to_string()))?;
  let emitted = parsed
    .transpile(
      &TranspileOptions {
        decorators,
        verbatim_module_syntax: options.verbatim_module_syntax,
        imports_not_used_as_values: ImportsNotUsedAsValues::Remove,
        jsx: Some(jsx),
        var_decl_imports: false,
      },
      &TranspileModuleOptions { module_kind: None },
      &EmitOptions {
        source_map,
        remove_comments: options.remove_comments,
        ..Default::default()
      },
    )
    .map_err(|e| JsErrorBox::new("SyntaxError", e.to_string()))?
    .into_source();
  Ok(Output {
    code: emitted.text,
    map: emitted.source_map,
  })
}

#[op2]
#[serde]
pub fn op_done_transpile(
  #[string] source: String,
  #[serde] options: Options,
) -> Result<Output, JsErrorBox> {
  transpile(source, options)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn strips_types() {
    let out = transpile(
      "const a: number = 1;\nexport type T = string;".into(),
      Options::default(),
    )
    .unwrap();
    assert_eq!(out.code.trim(), "const a = 1;");
    assert!(out.map.is_none());
    assert!(transpile("const = ;".into(), Options::default()).is_err());
  }
}
