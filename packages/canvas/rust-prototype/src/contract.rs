//! Versioned, platform-independent scene admission. Wire bytes are UTF-8 JSON.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub const SCENE_VERSION: u32 = 2;
pub const PATCH_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
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

#[derive(Clone, Debug, Deserialize, Serialize)]
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
        let raw: serde_json::Value = match serde_json::from_slice(bytes) {
            Ok(v) => v,
            Err(e) => return Admission::reject(e.to_string(), 0, 0),
        };
        let unsupported = raw
            .get("commands")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter(|c| {
                        !matches!(
                            c.get("kind").and_then(|k| k.as_str()),
                            Some(
                                "quad"
                                    | "ninePatch"
                                    | "rasterText"
                                    | "stillImage"
                                    | "clipPush"
                                    | "clipPop"
                            )
                        )
                    })
                    .count()
            })
            .unwrap_or(0);
        if unsupported > 0 {
            self.refused_total += unsupported;
            return Admission::reject("unsupported command kind".into(), unsupported, 0);
        }
        let scene: Scene = match serde_json::from_value(raw) {
            Ok(v) => v,
            Err(e) => return Admission::reject(e.to_string(), 0, 0),
        };
        if let Err(e) = validate(&scene) {
            return Admission::reject(e, 0, 0);
        }
        if self.scene.as_ref().is_some_and(|current| scene.revision <= current.revision) {
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
