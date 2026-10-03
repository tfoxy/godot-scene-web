//! Versioned, platform-independent scene admission. Wire bytes are UTF-8 JSON.
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};

pub const SCENE_VERSION: u32 = 2;
pub const PATCH_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub key: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quad {
    pub resource: Option<String>,
    pub m: [f32; 6],
    pub w: f32,
    pub h: f32,
    pub src: [f32; 4],
    pub color: [f32; 4],
    pub blend: Blend,
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
    pub color_matrix: Option<[f32; 9]>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Blend {
    Mix,
    Add,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GlyphMethod {
    Msdf,
    Sdf,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Glyph {
    pub src: [f32; 4],
    pub dst: [f32; 4],
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlyphOutline {
    pub color: [f32; 4],
    pub width: f32,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlyphShadow {
    pub color: [f32; 4],
    pub offset: [f32; 2],
}

// `Deserialize` is hand-written below instead of derived: see the impl for why.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Command {
    Quad {
        id: String,
        #[serde(flatten)]
        quad: Quad,
    },
    NinePatch {
        id: String,
        #[serde(flatten)]
        quad: Quad,
        margins: [f32; 4],
    },
    RasterText {
        id: String,
        #[serde(flatten)]
        quad: Quad,
    },
    GlyphRun {
        id: String,
        atlas: String,
        m: [f32; 6],
        glyphs: Vec<Glyph>,
        method: GlyphMethod,
        fill: [f32; 4],
        outline: Option<GlyphOutline>,
        shadow: Option<GlyphShadow>,
        #[serde(rename = "pxRange")]
        px_range: f32,
        alpha: f32,
    },
    StillImage {
        id: String,
        #[serde(flatten)]
        quad: Quad,
    },
    ClipPush {
        id: String,
        rect: [f32; 4],
        radius: f32,
        outset: f32,
    },
    ClipPop {
        id: String,
    },
}
impl Command {
    pub fn id(&self) -> &str {
        match self {
            Self::Quad { id, .. }
            | Self::NinePatch { id, .. }
            | Self::RasterText { id, .. }
            | Self::GlyphRun { id, .. }
            | Self::StillImage { id, .. }
            | Self::ClipPush { id, .. }
            | Self::ClipPop { id } => id,
        }
    }
    pub fn kind(&self) -> u8 {
        match self {
            Self::Quad { .. } => 0,
            Self::NinePatch { .. } => 1,
            Self::RasterText { .. } => 2,
            Self::GlyphRun { .. } => 6,
            Self::StillImage { .. } => 3,
            Self::ClipPush { .. } => 4,
            Self::ClipPop { .. } => 5,
        }
    }
    pub fn quad(&self) -> Option<&Quad> {
        match self {
            Self::Quad { quad, .. }
            | Self::NinePatch { quad, .. }
            | Self::RasterText { quad, .. }
            | Self::StillImage { quad, .. } => Some(quad),
            _ => None,
        }
    }
}
const COMMAND_KINDS: &[&str] = &[
    "quad",
    "ninePatch",
    "rasterText",
    "glyphRun",
    "stillImage",
    "clipPush",
    "clipPop",
];
/// Field names a command object may carry, across every `kind`. `Other` (via `#[serde(other)]`)
/// absorbs anything else — a field that belongs to a different variant, or one this contract has never
/// heard of — the same way the old `#[serde(flatten)]` derive silently dropped it.
#[derive(Deserialize)]
#[serde(field_identifier)]
enum CommandField {
    #[serde(rename = "id")]
    Id,
    #[serde(rename = "kind")]
    Kind,
    #[serde(rename = "resource")]
    Resource,
    #[serde(rename = "m")]
    M,
    #[serde(rename = "w")]
    W,
    #[serde(rename = "h")]
    H,
    #[serde(rename = "src")]
    Src,
    #[serde(rename = "color")]
    Color,
    #[serde(rename = "blend")]
    Blend,
    #[serde(rename = "flipH")]
    FlipH,
    #[serde(rename = "flipV")]
    FlipV,
    #[serde(rename = "colorMatrix")]
    ColorMatrix,
    #[serde(rename = "margins")]
    Margins,
    #[serde(rename = "atlas")]
    Atlas,
    #[serde(rename = "glyphs")]
    Glyphs,
    #[serde(rename = "method")]
    Method,
    #[serde(rename = "fill")]
    Fill,
    #[serde(rename = "outline")]
    Outline,
    #[serde(rename = "shadow")]
    Shadow,
    #[serde(rename = "pxRange")]
    PxRange,
    #[serde(rename = "alpha")]
    Alpha,
    #[serde(rename = "rect")]
    Rect,
    #[serde(rename = "radius")]
    Radius,
    #[serde(rename = "outset")]
    Outset,
    #[serde(other)]
    Other,
}
struct CommandVisitor;
impl<'de> serde::de::Visitor<'de> for CommandVisitor {
    type Value = Command;
    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("struct Command")
    }
    /// Reads every field straight into its final type in one pass over the JSON map — never into a
    /// generic `Value`/`Content` tree — and only decides which `Command` variant to build once `kind`
    /// (which may appear anywhere in the object, not necessarily first) has been seen. This replaces
    /// `#[serde(tag = "kind", flatten)]`, which forced every command through serde's slowest
    /// deserialize path (`TaggedContentVisitor` -> `FlatMapDeserializer` -> `ContentDeserializer`),
    /// buffering the whole object before building the real struct.
    ///
    /// This is also why `AdmittedCommand` (below) does not call this directly: every field here is
    /// type-parsed as it streams past, so a command whose `kind` turns out to be unsupported would
    /// still hard-fail on, say, a `w` that is a string instead of a number, rather than being counted.
    /// `AdmittedCommand` classifies `kind` on its own, lightweight terms first, and only reaches this
    /// visitor once `kind` is confirmed to be one of the seven below.
    fn visit_map<A>(self, mut map: A) -> Result<Command, A::Error>
    where
        A: serde::de::MapAccess<'de>,
    {
        let mut id: Option<String> = None;
        let mut kind: Option<String> = None;
        let mut resource: Option<Option<String>> = None;
        let mut m: Option<[f32; 6]> = None;
        let mut w: Option<f32> = None;
        let mut h: Option<f32> = None;
        let mut src: Option<[f32; 4]> = None;
        let mut color: Option<[f32; 4]> = None;
        let mut blend: Option<Blend> = None;
        let mut flip_h: Option<bool> = None;
        let mut flip_v: Option<bool> = None;
        let mut color_matrix: Option<Option<[f32; 9]>> = None;
        let mut margins: Option<[f32; 4]> = None;
        let mut atlas: Option<String> = None;
        let mut glyphs: Option<Vec<Glyph>> = None;
        let mut method: Option<GlyphMethod> = None;
        let mut fill: Option<[f32; 4]> = None;
        let mut outline: Option<Option<GlyphOutline>> = None;
        let mut shadow: Option<Option<GlyphShadow>> = None;
        let mut px_range: Option<f32> = None;
        let mut alpha: Option<f32> = None;
        let mut rect: Option<[f32; 4]> = None;
        let mut radius: Option<f32> = None;
        let mut outset: Option<f32> = None;
        macro_rules! fill_once {
            ($slot:ident, $name:literal) => {{
                if $slot.is_some() {
                    return Err(serde::de::Error::duplicate_field($name));
                }
                $slot = Some(map.next_value()?);
            }};
        }
        while let Some(field) = map.next_key::<CommandField>()? {
            match field {
                CommandField::Id => fill_once!(id, "id"),
                CommandField::Kind => fill_once!(kind, "kind"),
                CommandField::Resource => fill_once!(resource, "resource"),
                CommandField::M => fill_once!(m, "m"),
                CommandField::W => fill_once!(w, "w"),
                CommandField::H => fill_once!(h, "h"),
                CommandField::Src => fill_once!(src, "src"),
                CommandField::Color => fill_once!(color, "color"),
                CommandField::Blend => fill_once!(blend, "blend"),
                CommandField::FlipH => fill_once!(flip_h, "flipH"),
                CommandField::FlipV => fill_once!(flip_v, "flipV"),
                CommandField::ColorMatrix => fill_once!(color_matrix, "colorMatrix"),
                CommandField::Margins => fill_once!(margins, "margins"),
                CommandField::Atlas => fill_once!(atlas, "atlas"),
                CommandField::Glyphs => fill_once!(glyphs, "glyphs"),
                CommandField::Method => fill_once!(method, "method"),
                CommandField::Fill => fill_once!(fill, "fill"),
                CommandField::Outline => fill_once!(outline, "outline"),
                CommandField::Shadow => fill_once!(shadow, "shadow"),
                CommandField::PxRange => fill_once!(px_range, "pxRange"),
                CommandField::Alpha => fill_once!(alpha, "alpha"),
                CommandField::Rect => fill_once!(rect, "rect"),
                CommandField::Radius => fill_once!(radius, "radius"),
                CommandField::Outset => fill_once!(outset, "outset"),
                CommandField::Other => {
                    map.next_value::<serde::de::IgnoredAny>()?;
                }
            }
        }
        let id = id.ok_or_else(|| serde::de::Error::missing_field("id"))?;
        let kind = kind.ok_or_else(|| serde::de::Error::missing_field("kind"))?;
        fn quad_from<E: serde::de::Error>(
            resource: Option<Option<String>>,
            m: Option<[f32; 6]>,
            w: Option<f32>,
            h: Option<f32>,
            src: Option<[f32; 4]>,
            color: Option<[f32; 4]>,
            blend: Option<Blend>,
            flip_h: Option<bool>,
            flip_v: Option<bool>,
            color_matrix: Option<Option<[f32; 9]>>,
        ) -> Result<Quad, E> {
            Ok(Quad {
                resource: resource.unwrap_or(None),
                m: m.ok_or_else(|| E::missing_field("m"))?,
                w: w.ok_or_else(|| E::missing_field("w"))?,
                h: h.ok_or_else(|| E::missing_field("h"))?,
                src: src.ok_or_else(|| E::missing_field("src"))?,
                color: color.ok_or_else(|| E::missing_field("color"))?,
                blend: blend.ok_or_else(|| E::missing_field("blend"))?,
                flip_h: flip_h.unwrap_or(false),
                flip_v: flip_v.unwrap_or(false),
                color_matrix: color_matrix.unwrap_or(None),
            })
        }
        match kind.as_str() {
            "quad" => Ok(Command::Quad {
                id,
                quad: quad_from(
                    resource, m, w, h, src, color, blend, flip_h, flip_v, color_matrix,
                )?,
            }),
            "ninePatch" => Ok(Command::NinePatch {
                id,
                quad: quad_from(
                    resource, m, w, h, src, color, blend, flip_h, flip_v, color_matrix,
                )?,
                margins: margins.ok_or_else(|| serde::de::Error::missing_field("margins"))?,
            }),
            "rasterText" => Ok(Command::RasterText {
                id,
                quad: quad_from(
                    resource, m, w, h, src, color, blend, flip_h, flip_v, color_matrix,
                )?,
            }),
            "stillImage" => Ok(Command::StillImage {
                id,
                quad: quad_from(
                    resource, m, w, h, src, color, blend, flip_h, flip_v, color_matrix,
                )?,
            }),
            "glyphRun" => Ok(Command::GlyphRun {
                id,
                atlas: atlas.ok_or_else(|| serde::de::Error::missing_field("atlas"))?,
                m: m.ok_or_else(|| serde::de::Error::missing_field("m"))?,
                glyphs: glyphs.ok_or_else(|| serde::de::Error::missing_field("glyphs"))?,
                method: method.ok_or_else(|| serde::de::Error::missing_field("method"))?,
                fill: fill.ok_or_else(|| serde::de::Error::missing_field("fill"))?,
                outline: outline.unwrap_or(None),
                shadow: shadow.unwrap_or(None),
                px_range: px_range.ok_or_else(|| serde::de::Error::missing_field("pxRange"))?,
                alpha: alpha.ok_or_else(|| serde::de::Error::missing_field("alpha"))?,
            }),
            "clipPush" => Ok(Command::ClipPush {
                id,
                rect: rect.ok_or_else(|| serde::de::Error::missing_field("rect"))?,
                radius: radius.ok_or_else(|| serde::de::Error::missing_field("radius"))?,
                outset: outset.ok_or_else(|| serde::de::Error::missing_field("outset"))?,
            }),
            "clipPop" => Ok(Command::ClipPop { id }),
            other => Err(serde::de::Error::unknown_variant(other, COMMAND_KINDS)),
        }
    }
}
impl<'de> Deserialize<'de> for Command {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(CommandVisitor)
    }
}
/// Everything needed to classify one command's `kind` without type-checking anything else about it,
/// deliberately not `deny_unknown_fields`: an unsupported command may carry any other field (wrong
/// type, wrong shape, or just a name this contract has never heard of), and classifying it must not
/// fail on that. `kind` is `serde_json::Value` rather than `String` so a non-string `kind` (e.g. a
/// number) comes back as `Some(non-string)` — classified as unsupported by `as_str()` below — rather
/// than failing the probe itself. A single JSON `kind` key is matched exactly once, so a duplicate
/// `kind` on one command object is a `serde` "duplicate field" error, same as every other duplicate
/// key in this contract: `JSON.stringify` cannot produce one, so this never happens for real traffic.
#[derive(Deserialize, Default)]
struct KindProbe {
    #[serde(default)]
    kind: Option<serde_json::Value>,
}
/// `true` if `text` (one command's raw JSON text) names a `kind` this contract models. Never
/// type-checks any other field, so a command whose `kind` turns out to be unsupported — or missing,
/// non-string, or not even a JSON object — classifies in O(that command's size) regardless of what
/// garbage its other fields hold, exactly as the old `Value`-based pre-scan treated it (`Value::get`
/// on a non-object, or a missing/non-string key, is uniformly `None`).
fn probed_kind_is_supported(text: &str) -> bool {
    if !text.trim_start().starts_with('{') {
        return false;
    }
    let probe: KindProbe = serde_json::from_str(text).unwrap_or_default();
    matches!(
        probe.kind.as_ref().and_then(|value| value.as_str()),
        Some(
            "quad"
                | "ninePatch"
                | "rasterText"
                | "glyphRun"
                | "stillImage"
                | "clipPush"
                | "clipPop"
        )
    )
}
/// Counts unsupported commands in one lightweight pass that type-checks nothing but `commands`
/// itself, and only captures each element's raw text (`RawValue`, no tree allocation) rather than
/// parsing it. This must run, and fully finish, before `SceneWire` (below) is ever attempted: `Scene`,
/// `resources` and every *supported* command are typed and `deny_unknown_fields`, so a scene with an
/// unsupported command AND some unrelated problem elsewhere (an unknown top-level field, a
/// non-string resource key, a wrongly typed field on a different, supported command) must still
/// report the unsupported count, not whichever error the typed parse happens to hit first.
fn count_unsupported_commands(bytes: &[u8]) -> Result<usize, serde_json::Error> {
    #[derive(Deserialize)]
    struct UnsupportedCountProbe<'a> {
        #[serde(default, borrow)]
        commands: Vec<&'a serde_json::value::RawValue>,
    }
    let probe: UnsupportedCountProbe = serde_json::from_slice(bytes)?;
    Ok(probe
        .commands
        .iter()
        .filter(|raw| !probed_kind_is_supported(raw.get()))
        .count())
}
/// A command decoded for `SceneState::admit`, once `count_unsupported_commands` has already
/// established every command's `kind` is one this contract models: classifies again on the same cheap
/// terms (so this and `count_unsupported_commands` stay provably consistent with each other) before
/// paying for the real, fully-typed `Command` — through the same fast visitor `Command::deserialize`
/// uses. `Unsupported` should therefore never actually occur here; `SceneState::admit` treats it as
/// unreachable rather than trusting that invariant silently.
enum AdmittedCommand {
    Command(Command),
    Unsupported,
}
impl<'de> Deserialize<'de> for AdmittedCommand {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = <&serde_json::value::RawValue>::deserialize(deserializer)?;
        let text = raw.get();
        if !probed_kind_is_supported(text) {
            return Ok(AdmittedCommand::Unsupported);
        }
        serde_json::from_str(text).map(AdmittedCommand::Command).map_err(|e| {
            // `e`'s line/column are relative to `text` — this command's own isolated slice — not to
            // the document `bytes` actually came from, so baking that into the message (as `e`'s own
            // `Display` would) misreads as a position inside a totally different command. Stripping
            // it here, rather than discarding the position altogether, is deliberate: the error this
            // returns still carries serde_json's own "unset" (0, 0) position, and serde_json's own
            // `Deserializer`, seeing that once this bubbles back up through the live parse of
            // `bytes`, fixes it up to wherever it has actually reached by then — document-relative,
            // if only roughly (the end of this command, not the exact field), the same way a
            // `missing_field`/`duplicate_field` error raised deep inside any other visitor in this
            // file already gets its real position for free.
            let message = e.to_string();
            let message = message.split(" at line ").next().unwrap_or(&message);
            serde::de::Error::custom(message)
        })
    }
}
/// Mirrors `Scene` field-for-field, but through `AdmittedCommand` so an unsupported command kind does
/// not abort the whole parse. Reached only after `count_unsupported_commands` finds none — see there
/// for why counting and this typed parse cannot be the same pass.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SceneWire {
    version: u32,
    revision: u64,
    width: u32,
    height: u32,
    design_width: u32,
    design_height: u32,
    resources: Vec<Resource>,
    commands: Vec<AdmittedCommand>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scene {
    pub version: u32,
    pub revision: u64,
    /// Backing surface pixels; geometry remains in design space.
    pub width: u32,
    pub height: u32,
    pub design_width: u32,
    pub design_height: u32,
    pub resources: Vec<Resource>,
    pub commands: Vec<Command>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Patch {
    pub version: u32,
    pub base_revision: u64,
    pub revision: u64,
    pub updates: Vec<Update>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Update {
    pub id: String,
    pub command: Command,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    pub accepted: bool,
    pub revision: Option<u64>,
    pub unsupported_commands: usize,
    pub resource_pending: usize,
    pub error: Option<String>,
}
impl Admission {
    fn ok(revision: u64) -> Self {
        Self {
            accepted: true,
            revision: Some(revision),
            unsupported_commands: 0,
            resource_pending: 0,
            error: None,
        }
    }
    fn reject(error: String, unsupported: usize, pending: usize) -> Self {
        Self {
            accepted: false,
            revision: None,
            unsupported_commands: unsupported,
            resource_pending: pending,
            error: Some(error),
        }
    }
}

#[derive(Default)]
pub struct SceneState {
    scene: Option<Scene>,
    command_indices: HashMap<String, usize>,
    clip_indices: Vec<[Option<usize>; 3]>,
    pub refused_total: usize,
}
impl SceneState {
    pub fn scene(&self) -> Option<&Scene> {
        self.scene.as_ref()
    }
    pub fn set_scene(&mut self, scene: Scene) {
        self.command_indices = scene
            .commands
            .iter()
            .enumerate()
            .map(|(i, c)| (c.id().to_owned(), i))
            .collect();
        let mut stack = Vec::new();
        self.clip_indices = scene
            .commands
            .iter()
            .enumerate()
            .map(|(index, command)| {
                let mut clips = [None; 3];
                for (slot, clip) in stack.iter().enumerate() {
                    clips[slot] = Some(*clip);
                }
                match command {
                    Command::ClipPush { .. } => stack.push(index),
                    Command::ClipPop { .. } => {
                        stack.pop();
                    }
                    _ => {}
                }
                clips
            })
            .collect();
        self.scene = Some(scene)
    }
    pub fn command_index(&self, id: &str) -> Option<usize> {
        self.command_indices.get(id).copied()
    }
    pub fn clips_at(&self, index: usize) -> Option<&[Option<usize>; 3]> {
        self.clip_indices.get(index)
    }
    /// `ready` may be omitted while the resource-dimension epoch equals the last admitted epoch.
    pub fn preflight_patch(
        &self,
        patch: &Patch,
        ready: Option<&HashMap<String, (u32, u32)>>,
    ) -> Result<Vec<(usize, Command)>, String> {
        let current = self.scene.as_ref().ok_or("no scene")?;
        if patch.version != PATCH_VERSION
            || patch.base_revision != current.revision
            || patch.revision <= current.revision
        {
            return Err("version or revision mismatch".into());
        }
        let mut seen = HashSet::new();
        let mut replacements = Vec::with_capacity(patch.updates.len());
        for update in &patch.updates {
            if !seen.insert(&update.id) {
                return Err("duplicate patch id".into());
            }
            let index = self.command_index(&update.id).ok_or("unknown patch id")?;
            if update.id != update.command.id()
                || current.commands[index].kind() != update.command.kind()
            {
                return Err("patch shape mismatch".into());
            }
            validate_command(&update.command, &current.resources)?;
            replacements.push((index, update.command.clone()));
        }
        if ready.is_some_and(|ready| missing(current, ready) > 0) {
            return Err("resources not ready".into());
        }
        Ok(replacements)
    }
    pub fn commit_updates(&mut self, revision: u64, updates: Vec<(usize, Command)>) {
        let scene = self.scene.as_mut().expect("committed scene exists");
        for (index, command) in updates {
            scene.commands[index] = command;
        }
        scene.revision = revision;
    }
    pub fn admit(&mut self, bytes: &[u8], ready: &HashMap<String, (u32, u32)>) -> Admission {
        // Counting must fully finish, and win, before the typed `SceneWire` parse below is even
        // attempted: `Scene`/`resources`/every supported command are typed and `deny_unknown_fields`,
        // so a scene with an unsupported command AND an unrelated problem elsewhere would otherwise
        // report whichever the typed parse's single pass happened to hit first, not the unsupported
        // count — see `count_unsupported_commands`. Still far cheaper than the old two full-document
        // passes: this one never type-checks anything, or builds a tree for anything, but `commands`.
        let unsupported = match count_unsupported_commands(bytes) {
            Ok(count) => count,
            Err(e) => return Admission::reject(e.to_string(), 0, 0),
        };
        if unsupported > 0 {
            self.refused_total += unsupported;
            return Admission::reject("unsupported command kind".into(), unsupported, 0);
        }
        let wire: SceneWire = match serde_json::from_slice(bytes) {
            Ok(v) => v,
            Err(e) => return Admission::reject(e.to_string(), 0, 0),
        };
        let scene = Scene {
            version: wire.version,
            revision: wire.revision,
            width: wire.width,
            height: wire.height,
            design_width: wire.design_width,
            design_height: wire.design_height,
            resources: wire.resources,
            commands: wire
                .commands
                .into_iter()
                .map(|c| match c {
                    AdmittedCommand::Command(command) => command,
                    AdmittedCommand::Unsupported => {
                        unreachable!("checked above: unsupported == 0")
                    }
                })
                .collect(),
        };
        if let Err(e) = validate(&scene) {
            return Admission::reject(e, 0, 0);
        }
        if self
            .scene
            .as_ref()
            .is_some_and(|current| scene.revision <= current.revision)
        {
            return Admission::reject("version or revision mismatch".into(), 0, 0);
        }
        let pending = missing(&scene, ready);
        if pending > 0 {
            return Admission::reject("resources not ready".into(), 0, pending);
        }
        let revision = scene.revision;
        self.set_scene(scene);
        Admission::ok(revision)
    }
    pub fn patch(&mut self, bytes: &[u8], ready: &HashMap<String, (u32, u32)>) -> Admission {
        let patch: Patch = match serde_json::from_slice(bytes) {
            Ok(v) => v,
            Err(e) => return Admission::reject(e.to_string(), 0, 0),
        };
        self.patch_parsed(patch, ready)
    }
    pub fn patch_parsed(&mut self, patch: Patch, ready: &HashMap<String, (u32, u32)>) -> Admission {
        let Some(current) = self.scene.as_ref() else {
            return Admission::reject("no scene".into(), 0, 0);
        };
        if patch.version != PATCH_VERSION
            || patch.base_revision != current.revision
            || patch.revision <= current.revision
        {
            return Admission::reject("version or revision mismatch".into(), 0, 0);
        }
        let mut seen = HashSet::new();
        let mut replacements = Vec::with_capacity(patch.updates.len());
        let mut changed_clips = false;
        for update in patch.updates {
            if !seen.insert(update.id.clone()) {
                return Admission::reject("duplicate patch id".into(), 0, 0);
            }
            let Some(&index) = self.command_indices.get(&update.id) else {
                return Admission::reject("unknown patch id".into(), 0, 0);
            };
            if update.id != update.command.id()
                || current.commands[index].kind() != update.command.kind()
            {
                return Admission::reject("patch shape mismatch".into(), 0, 0);
            }
            if matches!(
                update.command,
                Command::ClipPush { .. } | Command::ClipPop { .. }
            ) {
                changed_clips = true;
            }
            if let Err(e) = validate_command(&update.command, &current.resources) {
                return Admission::reject(e, 0, 0);
            }
            replacements.push((index, update.command));
        }
        let pending = missing(current, ready);
        if pending > 0 {
            return Admission::reject("resources not ready".into(), 0, pending);
        }
        if changed_clips {
            let mut next = current.clone();
            for (index, command) in &replacements {
                next.commands[*index] = command.clone();
            }
            next.revision = patch.revision;
            if let Err(e) = validate(&next) {
                return Admission::reject(e, 0, 0);
            }
            self.set_scene(next);
        } else {
            let scene = self.scene.as_mut().expect("scene exists");
            for (index, command) in replacements {
                scene.commands[index] = command;
            }
            scene.revision = patch.revision;
        }
        Admission::ok(patch.revision)
    }
}
pub fn validate_command(command: &Command, resources: &[Resource]) -> Result<(), String> {
    if command.id().is_empty() {
        return Err("invalid or duplicate command id".into());
    }
    match command {
        Command::ClipPush {
            rect,
            radius,
            outset,
            ..
        } if !rect.iter().all(|v| v.is_finite()) || !radius.is_finite() || !outset.is_finite() => {
            return Err("invalid clip".into());
        }
        _ => {}
    }
    if let Command::GlyphRun {
        atlas,
        m,
        glyphs,
        fill,
        outline,
        shadow,
        px_range,
        alpha,
        ..
    } = command
    {
        let atlas_resource = resources.iter().find(|resource| &resource.key == atlas);
        if glyphs.is_empty()
            || glyphs.len() > 4096
            || !px_range.is_finite()
            || *px_range <= 0.0
            || !alpha.is_finite()
            || *alpha < 0.0
            || *alpha > 1.0
            || !m.iter().chain(fill).all(|v| v.is_finite())
            || atlas_resource.is_none()
            || glyphs.iter().any(|g| {
                !g.src.iter().chain(&g.dst).all(|v| v.is_finite())
                    || g.src[0] < 0.0
                    || g.src[1] < 0.0
                    || g.src[2] <= 0.0
                    || g.src[3] <= 0.0
                    || atlas_resource.is_some_and(|resource| {
                        g.src[0] + g.src[2] > resource.width as f32
                            || g.src[1] + g.src[3] > resource.height as f32
                    })
                    || g.dst[2] <= 0.0
                    || g.dst[3] <= 0.0
            })
            || outline.as_ref().is_some_and(|v| {
                !v.width.is_finite() || v.width < 0.0 || !v.color.iter().all(|x| x.is_finite())
            })
            || shadow
                .as_ref()
                .is_some_and(|v| !v.offset.iter().chain(&v.color).all(|x| x.is_finite()))
        {
            return Err("invalid glyph run".into());
        }
    }
    if let Some(q) = command.quad() {
        if !q
            .m
            .iter()
            .chain(q.src.iter())
            .chain(q.color.iter())
            .chain(q.color_matrix.iter().flatten())
            .chain([&q.w, &q.h])
            .all(|v| v.is_finite())
            || q.w < 0.0
            || q.h < 0.0
            || q.src[2] < 0.0
            || q.src[3] < 0.0
        {
            return Err("invalid quad".into());
        }
        if let Some(key) = &q.resource {
            if !resources.iter().any(|r| &r.key == key) {
                return Err("unknown resource".into());
            }
        }
    }
    Ok(())
}
fn missing(scene: &Scene, ready: &HashMap<String, (u32, u32)>) -> usize {
    scene
        .resources
        .iter()
        .filter(|r| ready.get(&r.key) != Some(&(r.width, r.height)))
        .count()
}
fn validate(scene: &Scene) -> Result<(), String> {
    if scene.version != SCENE_VERSION
        || scene.width == 0
        || scene.height == 0
        || scene.design_width == 0
        || scene.design_height == 0
    {
        return Err("invalid scene header".into());
    }
    let mut resource_keys = HashSet::new();
    for r in &scene.resources {
        if r.key.is_empty() || r.width == 0 || r.height == 0 || !resource_keys.insert(&r.key) {
            return Err("invalid or duplicate resource".into());
        }
    }
    let mut ids = HashSet::new();
    let mut depth = 0;
    for c in &scene.commands {
        if c.id().is_empty() || !ids.insert(c.id()) {
            return Err("invalid or duplicate command id".into());
        }
        validate_command(c, &scene.resources)?;
        match c {
            Command::ClipPush {
                rect,
                radius,
                outset,
                ..
            } => {
                if depth == 3
                    || !rect.iter().all(|v| v.is_finite())
                    || !radius.is_finite()
                    || !outset.is_finite()
                {
                    return Err("invalid clip".into());
                }
                depth += 1
            }
            Command::ClipPop { .. } => {
                if depth == 0 {
                    return Err("unbalanced clip".into());
                }
                depth -= 1
            }
            _ => {}
        }
        if let Some(q) = c.quad() {
            if !q
                .m
                .iter()
                .chain(q.src.iter())
                .chain(q.color.iter())
                .chain(q.color_matrix.iter().flatten())
                .chain([&q.w, &q.h])
                .all(|v| v.is_finite())
                || q.w < 0.0
                || q.h < 0.0
                || q.src[2] < 0.0
                || q.src[3] < 0.0
            {
                return Err("invalid quad".into());
            }
            if let Some(k) = &q.resource {
                if !resource_keys.contains(k) {
                    return Err("unknown resource".into());
                }
            }
        }
    }
    if depth != 0 {
        return Err("unbalanced clip".into());
    }
    Ok(())
}
