//! Read-only local QA helper: map Unicode scalars to glyph IDs in a supplied font.
use std::{env, fs};
use ttf_parser::Face;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let path = args
        .next()
        .ok_or("usage: inspect-font-ids FONT.ttf CHARACTERS")?;
    let characters = args.next().ok_or("missing characters")?;
    let font = fs::read(path)?;
    let face = Face::parse(&font, 0)?;
    for character in characters.chars() {
        println!(
            "U+{:04X} {} {}",
            character as u32,
            character,
            face.glyph_index(character).map_or(0, |id| id.0)
        );
    }
    Ok(())
}
