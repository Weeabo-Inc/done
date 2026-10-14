// Copyright 2018-2026 the Deno authors. MIT license.

//! `Deno.xml.parse()`: an XML document into a tree of elements and text.
//!
//! Only the five predefined entities and character references are expanded.
//! A DTD is skipped and its custom entities are errors, so a "billion
//! laughs" document can't grow. Nesting is limited, and the tree is built
//! without recursion.

use deno_core::op2;
use deno_error::JsErrorBox;
use quick_xml::Reader;
use quick_xml::events::BytesStart;
use quick_xml::events::Event;
use serde::Serialize;

const MAX_DEPTH: usize = 256;

#[derive(Serialize)]
#[serde(untagged)]
pub enum Node {
  Text(String),
  Element(Element),
}

#[derive(Serialize, Default)]
pub struct Element {
  name: String,
  /// Pairs, in document order.
  attributes: Vec<(String, String)>,
  children: Vec<Node>,
}

fn error(reader: &Reader<&[u8]>, e: impl std::fmt::Display) -> JsErrorBox {
  JsErrorBox::new(
    "SyntaxError",
    format!("Invalid XML at byte {}: {e}", reader.error_position()),
  )
}

fn element_of(
  reader: &Reader<&[u8]>,
  start: &BytesStart,
) -> Result<Element, JsErrorBox> {
  let name = std::str::from_utf8(start.name().as_ref())
    .map_err(|e| error(reader, e))?
    .to_string();
  let mut attributes = Vec::new();
  for attribute in start.attributes() {
    let attribute = attribute.map_err(|e| error(reader, e))?;
    let key = std::str::from_utf8(attribute.key.as_ref())
      .map_err(|e| error(reader, e))?
      .to_string();
    let value = attribute
      .unescape_value()
      .map_err(|e| error(reader, e))?
      .into_owned();
    attributes.push((key, value));
  }
  Ok(Element {
    name,
    attributes,
    children: Vec::new(),
  })
}

/// Appends text to the open element, joining it to a preceding text node so
/// that entity references and CDATA don't split a string.
fn push_text(open: &mut Element, text: &str) {
  if let Some(Node::Text(last)) = open.children.last_mut() {
    last.push_str(text);
  } else {
    open.children.push(Node::Text(text.to_string()));
  }
}

pub fn parse(text: &str, keep_whitespace: bool) -> Result<Element, JsErrorBox> {
  let mut reader = Reader::from_str(text);
  reader.config_mut().check_end_names = true;
  reader.config_mut().expand_empty_elements = false;

  let mut stack: Vec<Element> = Vec::new();
  let mut root: Option<Element> = None;
  loop {
    let event = reader.read_event().map_err(|e| error(&reader, e))?;
    match event {
      Event::Start(start) => {
        if root.is_some() {
          return Err(error(&reader, "more than one root element"));
        }
        if stack.len() >= MAX_DEPTH {
          return Err(error(&reader, "elements nested too deeply"));
        }
        stack.push(element_of(&reader, &start)?);
      }
      Event::Empty(start) => {
        let element = element_of(&reader, &start)?;
        match stack.last_mut() {
          Some(parent) => parent.children.push(Node::Element(element)),
          None if root.is_none() => root = Some(element),
          None => return Err(error(&reader, "more than one root element")),
        }
      }
      Event::End(_) => {
        let element = stack.pop().expect("check_end_names rejects strays");
        match stack.last_mut() {
          Some(parent) => parent.children.push(Node::Element(element)),
          None => root = Some(element),
        }
      }
      Event::Text(t) => {
        let t = t.decode().map_err(|e| error(&reader, e))?;
        match stack.last_mut() {
          Some(open) => push_text(open, &t),
          None if t.trim().is_empty() => {}
          None => {
            return Err(error(&reader, "text outside the root element"));
          }
        }
      }
      Event::CData(c) => {
        let c = c.decode().map_err(|e| error(&reader, e))?;
        match stack.last_mut() {
          Some(open) => push_text(open, &c),
          None => return Err(error(&reader, "CDATA outside the root element")),
        }
      }
      Event::GeneralRef(r) => {
        let Some(open) = stack.last_mut() else {
          return Err(error(&reader, "reference outside the root element"));
        };
        let name = r.decode().map_err(|e| error(&reader, e))?;
        if let Some(c) = r.resolve_char_ref().map_err(|e| error(&reader, e))? {
          push_text(open, c.encode_utf8(&mut [0; 4]));
        } else {
          let value = match name.as_ref() {
            "lt" => "<",
            "gt" => ">",
            "amp" => "&",
            "apos" => "'",
            "quot" => "\"",
            other => {
              return Err(error(
                &reader,
                format!(
                  "unknown entity &{other}; (DTD entities are not supported)"
                ),
              ));
            }
          };
          push_text(open, value);
        }
      }
      Event::Comment(_) | Event::PI(_) | Event::Decl(_) | Event::DocType(_) => {
      }
      Event::Eof => break,
    }
  }
  if let Some(open) = stack.last() {
    return Err(error(&reader, format!("unclosed element <{}>", open.name)));
  }
  let mut root = root.ok_or_else(|| error(&reader, "no root element"))?;
  if !keep_whitespace {
    drop_blank_text(&mut root);
  }
  Ok(root)
}

/// Removes whitespace-only text between elements (indentation), leaving text
/// that has any content, and elements that hold only text, untouched.
fn drop_blank_text(root: &mut Element) {
  let mut work = vec![root];
  while let Some(element) = work.pop() {
    let has_elements = element
      .children
      .iter()
      .any(|c| matches!(c, Node::Element(_)));
    if has_elements {
      element
        .children
        .retain(|c| !matches!(c, Node::Text(t) if t.trim().is_empty()));
    }
    for child in &mut element.children {
      if let Node::Element(e) = child {
        work.push(e);
      }
    }
  }
}

#[op2]
#[serde]
pub fn op_done_xml_parse(
  #[string] text: &str,
  keep_whitespace: bool,
) -> Result<Element, JsErrorBox> {
  parse(text, keep_whitespace)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn json(text: &str) -> String {
    serde_json::to_string(&parse(text, false).unwrap()).unwrap()
  }

  #[test]
  fn parses_a_document() {
    assert_eq!(
      json(
        "<?xml version=\"1.0\"?><!-- c --><a x=\"1&amp;2\" y='z'>\n  <b>t &lt; <![CDATA[<u>]]> &#65;</b>\n  <c/>\n</a>"
      ),
      r#"{"name":"a","attributes":[["x","1&2"],["y","z"]],"children":[{"name":"b","attributes":[],"children":["t < <u> A"]},{"name":"c","attributes":[],"children":[]}]}"#
    );
  }

  #[test]
  fn keeps_whitespace_on_request() {
    let e = parse("<a> <b/> </a>", true).unwrap();
    assert_eq!(e.children.len(), 3);
  }

  #[test]
  fn rejects_bad_documents() {
    for bad in [
      "",
      "<a>",
      "<a></b>",
      "<a/><b/>",
      "text",
      "<a>&nope;</a>",
      "<a x=\"1\" x=\"2\"/>",
      "<!DOCTYPE a [<!ENTITY e \"x\">]><a>&e;</a>",
    ] {
      assert!(parse(bad, false).is_err(), "{bad}");
    }
    let deep = "<a>".repeat(300) + "</a>".repeat(300).as_str();
    assert!(parse(&deep, false).is_err());
    // Within the limit, and no stack overflow while dropping it.
    let ok = "<a>".repeat(200) + "</a>".repeat(200).as_str();
    assert!(parse(&ok, false).is_ok());
  }
}
