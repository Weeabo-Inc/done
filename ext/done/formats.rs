// Copyright 2018-2026 the Deno authors. MIT license.

//! TOML, YAML and CSV for `Deno.toml`, `Deno.yaml` and `Deno.csv`.
//!
//! Values cross the op boundary as JSON-compatible data. TOML dates and times
//! have no JSON equivalent, so they are returned as their TOML string form.

use deno_core::op2;
use deno_error::JsErrorBox;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;

fn syntax_error(kind: &str, e: impl std::fmt::Display) -> JsErrorBox {
  JsErrorBox::new("SyntaxError", format!("Invalid {kind}: {e}"))
}

fn toml_to_json(value: toml::Value) -> Value {
  match value {
    toml::Value::String(s) => Value::String(s),
    toml::Value::Integer(i) => Value::from(i),
    toml::Value::Float(f) => {
      serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
    }
    toml::Value::Boolean(b) => Value::Bool(b),
    toml::Value::Datetime(d) => Value::String(d.to_string()),
    toml::Value::Array(a) => {
      Value::Array(a.into_iter().map(toml_to_json).collect())
    }
    toml::Value::Table(t) => {
      Value::Object(t.into_iter().map(|(k, v)| (k, toml_to_json(v))).collect())
    }
  }
}

#[op2]
#[serde]
pub fn op_done_toml_parse(
  #[string] text: &str,
) -> Result<serde_json::Value, JsErrorBox> {
  let table: toml::Table =
    toml::from_str(text).map_err(|e| syntax_error("TOML", e))?;
  Ok(toml_to_json(toml::Value::Table(table)))
}

#[op2]
#[string]
pub fn op_done_toml_stringify(
  #[serde] value: serde_json::Value,
) -> Result<String, JsErrorBox> {
  if !value.is_object() {
    return Err(JsErrorBox::type_error(
      "TOML documents must be objects at the top level",
    ));
  }
  toml::to_string(&value).map_err(|e| JsErrorBox::type_error(e.to_string()))
}

#[op2]
#[serde]
pub fn op_done_yaml_parse(
  #[string] text: &str,
  all_documents: bool,
) -> Result<serde_json::Value, JsErrorBox> {
  let mut documents = Vec::new();
  for document in serde_yaml_ng::Deserializer::from_str(text) {
    let value =
      Value::deserialize(document).map_err(|e| syntax_error("YAML", e))?;
    documents.push(value);
  }
  if all_documents {
    Ok(Value::Array(documents))
  } else {
    Ok(documents.into_iter().next().unwrap_or(Value::Null))
  }
}

#[op2]
#[string]
pub fn op_done_yaml_stringify(
  #[serde] value: serde_json::Value,
) -> Result<String, JsErrorBox> {
  serde_yaml_ng::to_string(&value)
    .map_err(|e| JsErrorBox::type_error(e.to_string()))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CsvParseOptions {
  separator: Option<String>,
  /// Return objects keyed by the first row instead of arrays.
  #[serde(default)]
  header: bool,
  #[serde(default)]
  trim: bool,
}

fn separator_byte(separator: Option<&str>) -> Result<u8, JsErrorBox> {
  match separator {
    None => Ok(b','),
    Some(s) if s.len() == 1 => Ok(s.as_bytes()[0]),
    Some(_) => Err(JsErrorBox::type_error(
      "CSV separator must be a single ASCII character",
    )),
  }
}

#[op2]
#[serde]
pub fn op_done_csv_parse(
  #[string] text: &str,
  #[serde] options: Option<CsvParseOptions>,
) -> Result<serde_json::Value, JsErrorBox> {
  let options = options.unwrap_or_default();
  let mut reader = csv::ReaderBuilder::new()
    .delimiter(separator_byte(options.separator.as_deref())?)
    .has_headers(options.header)
    .flexible(!options.header)
    .trim(if options.trim {
      csv::Trim::All
    } else {
      csv::Trim::None
    })
    .from_reader(text.as_bytes());
  let csv_error = |e: csv::Error| syntax_error("CSV", e);

  if options.header {
    let headers = reader.headers().map_err(csv_error)?.clone();
    let mut rows = Vec::new();
    for record in reader.records() {
      let record = record.map_err(csv_error)?;
      let row: Map<String, Value> = headers
        .iter()
        .zip(record.iter())
        .map(|(k, v)| (k.to_string(), Value::String(v.to_string())))
        .collect();
      rows.push(Value::Object(row));
    }
    Ok(Value::Array(rows))
  } else {
    let mut rows = Vec::new();
    for record in reader.records() {
      let record = record.map_err(csv_error)?;
      rows.push(Value::Array(
        record
          .iter()
          .map(|v| Value::String(v.to_string()))
          .collect(),
      ));
    }
    Ok(Value::Array(rows))
  }
}

#[op2]
#[string]
pub fn op_done_csv_stringify(
  #[serde] rows: Vec<Vec<String>>,
  #[string] separator: Option<String>,
) -> Result<String, JsErrorBox> {
  let mut writer = csv::WriterBuilder::new()
    .delimiter(separator_byte(separator.as_deref())?)
    .flexible(true)
    .from_writer(Vec::new());
  for row in rows {
    writer
      .write_record(&row)
      .map_err(|e| JsErrorBox::type_error(e.to_string()))?;
  }
  let bytes = writer
    .into_inner()
    .map_err(|e| JsErrorBox::generic(e.to_string()))?;
  String::from_utf8(bytes).map_err(|e| JsErrorBox::generic(e.to_string()))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn toml_dates_become_strings() {
    let table: toml::Table =
      toml::from_str("a = 1979-05-27T07:32:00Z\nb = 2").unwrap();
    let v = toml_to_json(toml::Value::Table(table));
    assert_eq!(v["a"], "1979-05-27T07:32:00Z");
    assert_eq!(v["b"], 2);
  }
}
