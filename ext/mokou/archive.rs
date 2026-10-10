// Copyright 2018-2026 the Deno authors. MIT license.

//! `Deno.tar`: tar archives, optionally gzip-compressed, built and read in
//! memory. Reading and writing files on disk (`pack()` / `extract()`) is done
//! in JavaScript with the permission-checked file system APIs.

use std::io::Read;
use std::io::Write;

use deno_core::JsBuffer;
use deno_core::ToJsBuffer;
use deno_core::op2;
use deno_core::unsync::spawn_blocking;
use deno_error::JsErrorBox;
use serde::Deserialize;
use serde::Serialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryIn {
  path: String,
  r#type: String,
  mode: u32,
  /// Seconds since the epoch.
  mtime: u64,
  data: Option<JsBuffer>,
  link_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryOut {
  path: String,
  r#type: &'static str,
  mode: u32,
  mtime: u64,
  size: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  data: Option<ToJsBuffer>,
  #[serde(skip_serializing_if = "Option::is_none")]
  link_name: Option<String>,
}

fn invalid(e: impl std::fmt::Display) -> JsErrorBox {
  JsErrorBox::type_error(format!("Invalid tar archive: {e}"))
}

pub fn create(entries: &[EntryIn], gzip: bool) -> std::io::Result<Vec<u8>> {
  let mut builder = tar::Builder::new(Vec::new());
  for entry in entries {
    let mut header = tar::Header::new_gnu();
    header.set_mode(entry.mode);
    header.set_mtime(entry.mtime);
    header.set_uid(0);
    header.set_gid(0);
    match entry.r#type.as_str() {
      "directory" => {
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        builder.append_data(&mut header, &entry.path, std::io::empty())?;
      }
      kind @ ("symlink" | "link") => {
        header.set_entry_type(if kind == "symlink" {
          tar::EntryType::Symlink
        } else {
          tar::EntryType::Link
        });
        header.set_size(0);
        let target = entry.link_name.as_deref().unwrap_or_default();
        builder.append_link(&mut header, &entry.path, target)?;
      }
      _ => {
        let data = entry.data.as_deref().unwrap_or_default();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(data.len() as u64);
        builder.append_data(&mut header, &entry.path, data)?;
      }
    }
  }
  let archive = builder.into_inner()?;
  if !gzip {
    return Ok(archive);
  }
  let mut encoder =
    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
  encoder.write_all(&archive)?;
  encoder.finish()
}

pub fn read(data: &[u8]) -> Result<Vec<EntryOut>, JsErrorBox> {
  let mut decompressed;
  let data = if data.starts_with(&[0x1f, 0x8b]) {
    decompressed = Vec::new();
    flate2::read::MultiGzDecoder::new(data)
      .read_to_end(&mut decompressed)
      .map_err(invalid)?;
    &decompressed[..]
  } else {
    data
  };
  let mut archive = tar::Archive::new(data);
  let mut entries = Vec::new();
  for entry in archive.entries().map_err(invalid)? {
    let mut entry = entry.map_err(invalid)?;
    let header = entry.header();
    let r#type = match header.entry_type() {
      tar::EntryType::Regular | tar::EntryType::Continuous => "file",
      tar::EntryType::Directory => "directory",
      tar::EntryType::Symlink => "symlink",
      tar::EntryType::Link => "link",
      // PAX and GNU long-name headers are applied by `entries()`.
      tar::EntryType::XGlobalHeader => continue,
      _ => "other",
    };
    let mode = header.mode().map_err(invalid)?;
    let mtime = header.mtime().map_err(invalid)?;
    let path = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
    let link_name = entry
      .link_name_bytes()
      .map(|name| String::from_utf8_lossy(&name).into_owned());
    let size = entry.size();
    let data = if r#type == "file" {
      let mut buf = Vec::with_capacity(size as usize);
      entry.read_to_end(&mut buf).map_err(invalid)?;
      Some(buf.into())
    } else {
      None
    };
    entries.push(EntryOut {
      path,
      r#type,
      mode,
      mtime,
      size,
      data,
      link_name,
    });
  }
  Ok(entries)
}

#[op2]
#[serde]
pub async fn op_done_tar_create(
  #[serde] entries: Vec<EntryIn>,
  gzip: bool,
) -> Result<ToJsBuffer, JsErrorBox> {
  spawn_blocking(move || create(&entries, gzip))
    .await
    .map_err(|e| JsErrorBox::generic(e.to_string()))?
    .map(Into::into)
    .map_err(|e| JsErrorBox::type_error(e.to_string()))
}

#[op2]
#[serde]
pub async fn op_done_tar_read(
  #[buffer] data: JsBuffer,
) -> Result<Vec<EntryOut>, JsErrorBox> {
  spawn_blocking(move || read(&data))
    .await
    .map_err(|e| JsErrorBox::generic(e.to_string()))?
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn round_trip() {
    let long = format!("{}/file.txt", "d".repeat(150));
    let entries = vec![
      EntryIn {
        path: "dir".into(),
        r#type: "directory".into(),
        mode: 0o755,
        mtime: 1,
        data: None,
        link_name: None,
      },
      EntryIn {
        path: long.clone(),
        r#type: "file".into(),
        mode: 0o644,
        mtime: 2,
        data: None,
        link_name: None,
      },
      EntryIn {
        path: "dir/link".into(),
        r#type: "symlink".into(),
        mode: 0o777,
        mtime: 3,
        data: None,
        link_name: Some("../target".into()),
      },
    ];
    for gzip in [false, true] {
      let archive = create(&entries, gzip).unwrap();
      assert_eq!(archive.starts_with(&[0x1f, 0x8b]), gzip);
      let out = read(&archive).unwrap();
      assert_eq!(out.len(), 3);
      assert_eq!(out[0].path, "dir");
      assert_eq!(out[0].r#type, "directory");
      assert_eq!(out[1].path, long);
      assert_eq!((out[1].mode, out[1].mtime, out[1].size), (0o644, 2, 0));
      assert_eq!(out[2].r#type, "symlink");
      assert_eq!(out[2].link_name.as_deref(), Some("../target"));
    }
    assert!(read(b"\x1f\x8bnot gzip").is_err());
  }
}
