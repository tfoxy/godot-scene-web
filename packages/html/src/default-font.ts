import { GODOT_DEFAULT_FONT_DATA_URL } from "./default-font-data";

// Godot 4.5.1's default theme embeds OpenSans_SemiBold.woff2. Keep this
// separate from resolved FontFile / FontVariation faces: it is only the browser
// counterpart of a Control whose effective theme has no explicit font file.
export const GODOT_DEFAULT_FONT_FAMILY = "Godot Default";

export const godotDefaultFontFace = {
  fontFamily: GODOT_DEFAULT_FONT_FAMILY,
  url: GODOT_DEFAULT_FONT_DATA_URL,
  style: "normal",
  // The actual file is SemiBold, but Godot uses this same face for its normal
  // role and synthesizes the bold variation itself. Advertising it as 400 makes
  // browser role selection follow that effective default without replacing any
  // explicit FontFile/FontVariation mapping.
  weight: "400",
} as const;
