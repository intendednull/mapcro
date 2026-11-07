//! Panorama resource payloads (styles, layouts and SVG).
//!
//! Ported from ValveResourceFormat (MIT), `Resource/ResourceTypes/Panorama.cs`,
//! `PanoramaStyle.cs` and `PanoramaLayout.cs`:
//! <https://github.com/ValveResourceFormat/ValveResourceFormat>
//!
//! The `DATA` block starts with a CRC32, an image count, and a table of referenced images.
//! Styles and SVGs store their text after that table. Layouts store an AST in the `LaCo` block
//! instead; [`layout_xml`] reconstructs XML from it.

use crate::kv3::{self, Value};
use crate::{Error, Result};

/// Return the text payload after a Panorama `DATA` header.
pub fn text_payload(block: &[u8], resource_version: u16) -> Result<&[u8]> {
    let mut reader = Reader::new(block);
    let _crc = reader.u32()?;
    let image_count = reader.u16()?;

    for _ in 0..image_count {
        reader.cstr()?;
        reader.u16()?;
        reader.u16()?;
        if resource_version >= 3 {
            reader.u32()?;
        }
    }

    Ok(reader.remaining())
}

/// Reconstruct the XML text of a `LaCo` block.
pub fn layout_xml(block: &[u8]) -> Result<String> {
    let root = kv3::decode(block)?;
    let ast = root.get("m_AST").ok_or(Error::MalformedLayout)?;
    let root_node = ast.get("m_pRoot").ok_or(Error::MalformedLayout)?;

    let mut out = String::new();
    out.push_str("<!-- xml reconstructed by mapcro-extract -->\n");
    print_node(root_node, 0, &mut out)?;
    Ok(out)
}

fn print_node(node: &Value, depth: usize, out: &mut String) -> Result<()> {
    let node_type = node
        .get("eType")
        .and_then(Value::as_str)
        .ok_or(Error::MalformedLayout)?;

    match node_type {
        "ROOT" => print_panel_base("root", node, depth, out),
        "STYLES" => print_panel_base("styles", node, depth, out),
        "INCLUDE" => print_include(node, depth, out),
        "PANEL" => {
            let name = node
                .get("name")
                .and_then(Value::as_str)
                .ok_or(Error::MalformedLayout)?;
            print_panel_base(name, node, depth, out)
        }
        "SCRIPT_BODY" => {
            let content = node.get("name").and_then(Value::as_str).unwrap_or_default();
            indent(out, depth);
            out.push_str("<script><![CDATA[");
            out.push_str(content);
            out.push_str("]]></script>\n");
            Ok(())
        }
        "SCRIPTS" => print_panel_base("scripts", node, depth, out),
        "SNIPPET" => {
            let name = node
                .get("name")
                .and_then(Value::as_str)
                .ok_or(Error::MalformedLayout)?;
            indent(out, depth);
            out.push_str(&format!("<snippet name=\"{}\">\n", escape(name)));
            for child in subnodes(node) {
                print_node(child, depth + 1, out)?;
            }
            indent(out, depth);
            out.push_str("</snippet>\n");
            Ok(())
        }
        "SNIPPETS" => print_panel_base("snippets", node, depth, out),
        other => Err(Error::UnknownLayoutNode(other.to_owned())),
    }
}

fn print_panel_base(name: &str, node: &Value, depth: usize, out: &mut String) -> Result<()> {
    let mut attributes = Vec::new();
    let mut children = Vec::new();
    for child in subnodes(node) {
        if is_attribute(child) {
            attributes.push(child);
        } else {
            children.push(child);
        }
    }

    indent(out, depth);
    out.push('<');
    out.push_str(name);
    for attribute in attributes {
        print_attribute(attribute, out)?;
    }

    if children.is_empty() {
        out.push_str(" />\n");
    } else {
        out.push_str(">\n");
        for child in children {
            print_node(child, depth + 1, out)?;
        }
        indent(out, depth);
        out.push_str(&format!("</{name}>\n"));
    }
    Ok(())
}

fn print_include(node: &Value, depth: usize, out: &mut String) -> Result<()> {
    let reference = node.get("child").ok_or(Error::MalformedLayout)?;
    indent(out, depth);
    out.push_str(&format!(
        "<include src=\"{}\" />\n",
        attribute_value(reference)?
    ));
    Ok(())
}

fn print_attribute(attribute: &Value, out: &mut String) -> Result<()> {
    let name = attribute
        .get("name")
        .and_then(Value::as_str)
        .ok_or(Error::MalformedLayout)?;
    let value = attribute.get("child").ok_or(Error::MalformedLayout)?;
    out.push(' ');
    out.push_str(name);
    out.push_str("=\"");
    out.push_str(&attribute_value(value)?);
    out.push('"');
    Ok(())
}

fn attribute_value(value: &Value) -> Result<String> {
    let name = value.get("name").and_then(Value::as_str).unwrap_or_default();
    let value_type = value
        .get("eType")
        .and_then(Value::as_str)
        .ok_or(Error::MalformedLayout)?;

    match value_type {
        "REFERENCE_COMPILED" => Ok(format!("s2r://{name}")),
        "REFERENCE_PASSTHROUGH" => Ok(format!("file://{name}")),
        "PANEL_ATTRIBUTE_VALUE" => Ok(escape(name)),
        other => Err(Error::UnknownLayoutNode(other.to_owned())),
    }
}

fn is_attribute(node: &Value) -> bool {
    node.get("eType").and_then(Value::as_str) == Some("PANEL_ATTRIBUTE")
}

fn subnodes(node: &Value) -> Vec<&Value> {
    if let Some(children) = node.get("vecChildren").and_then(Value::as_array) {
        return children.iter().collect();
    }
    if let Some(child) = node.get("child") {
        return vec![child];
    }
    Vec::new()
}

fn indent(out: &mut String, depth: usize) {
    for _ in 0..depth {
        out.push('\t');
    }
}

fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            other => out.push(other),
        }
    }
    out
}

struct Reader<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    fn remaining(&self) -> &'a [u8] {
        &self.data[self.position..]
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8]> {
        let end = self
            .position
            .checked_add(length)
            .ok_or(Error::MalformedPanorama)?;
        let bytes = self
            .data
            .get(self.position..end)
            .ok_or(Error::MalformedPanorama)?;
        self.position = end;
        Ok(bytes)
    }

    fn u16(&mut self) -> Result<u16> {
        let bytes = self.take(2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn u32(&mut self) -> Result<u32> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn cstr(&mut self) -> Result<&'a str> {
        let rest = self
            .data
            .get(self.position..)
            .ok_or(Error::MalformedPanorama)?;
        let end = rest
            .iter()
            .position(|byte| *byte == 0)
            .ok_or(Error::MalformedPanorama)?;
        let text = std::str::from_utf8(&rest[..end]).map_err(|_| Error::MalformedPanorama)?;
        self.position += end + 1;
        Ok(text)
    }
}
