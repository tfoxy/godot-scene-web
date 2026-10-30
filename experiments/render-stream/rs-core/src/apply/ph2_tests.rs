//! PH2: the dependency pass through [`DepIndex`] equals the full scan (`always_scan_dependencies`)
//! over random runs of texture resizes (resident and not), re-pointed and removed items, and
//! texture removals; its sabotage `skip_dep_textures` must be caught.

use super::*;
use crate::state::*;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const TEXTURES: [Id; 4] = [5, 6, 7, 8];

fn item(id: Id, commands: Commands) -> Item {
    Item {
        id,
        origin: Origin::Created,
        parent: Some(Parent {
            kind: ParentKind::Canvas,
            id: 1,
        }),
        children: Vec::new(),
        visible: true,
        draw_index: id as i64,
        z_index: 0,
        z_relative: true,
        behind: false,
        clip: false,
        custom_rect: false,
        visibility_layer: 1,
        texture_filter: Filter::Default,
        texture_repeat: Repeat::Default,
        material: None,
        use_parent_material: false,
        instance_params: Vec::new(),
        canvas_group: None,
        copy_to_backbuffer: None,
        use_identity_transform: false,
        content_version: 1,
        xform: geom::IDENTITY,
        modulate: [1.0; 4],
        self_modulate: [1.0; 4],
        custom_rect_rect: [0.0; 4],
        commands,
    }
}

fn draw_cmds(tex: Id, k: u64) -> Commands {
    Commands {
        list: vec![Command::TextureRectRegion {
            tex: Some(tex),
            transpose: false,
            clip_uv: false,
            rect: [(k % 7) as f32 * 4.0, (k % 5) as f32 * 3.0, 8.0, 8.0],
            src: [1.0, 2.0, 4.0, 4.0],
            modulate: [1.0; 4],
        }],
        ..Commands::default()
    }
}

fn texture(id: Id, size: u32, version: i64, hash: Hash) -> Texture {
    Texture {
        id,
        origin: Origin::Created,
        adopted_content: None,
        kind: TextureKind::Image,
        status: EntryStatus::Ok,
        reason: None,
        version,
        hash: Some(hash),
        format: Some("RGBA8".into()),
        source_format: None,
        width: i64::from(size),
        height: i64::from(size),
        mipmaps: false,
        payload_bytes: 100,
        variants: Vec::new(),
        canvas: None,
    }
}

fn pixels(size: u32) -> payloads::TexturePixels {
    payloads::TexturePixels {
        width: size,
        height: size,
        rgba: vec![255; (size * size * 4) as usize].into(),
        format: "RGBA8".into(),
        mipmaps: false,
        data_len: (size * size * 4) as usize,
        compressed: None,
        half: None,
        floats: None,
    }
}

/// One random run; `Some(step)` at the first step whose paint or stats differ.
fn run(seed: u64, steps: usize, sabotage: bool) -> Option<usize> {
    let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
    let mut s = ResolvedState::empty(6);
    let mut canvas = Canvas {
        id: 1,
        origin: Origin::RootQuery,
        root: true,
        attached: true,
        layer: 0,
        sublayer: 0,
        items: Vec::new(),
        xform: geom::IDENTITY,
        modulate: [1.0; 4],
    };
    let mut store = PayloadStore::default();
    let mut serial = 1u8;
    let mut put_texture = |s: &mut ResolvedState, store: &mut PayloadStore, id: Id, size: u32| {
        serial = serial.wrapping_add(1);
        let hash = Hash([serial; 32]);
        let version = s.textures.get(&id).map_or(1, |t| t.version + 1);
        s.textures.insert(id, texture(id, size, version, hash));
        store.textures.insert(hash, pixels(size));
    };
    for &t in &TEXTURES {
        put_texture(&mut s, &mut store, t, 4 + 4 * rng.below(4) as u32);
    }
    let mut next_id: Id = 10;
    for _ in 0..12 {
        let id = next_id;
        next_id += 1;
        let tex = TEXTURES[rng.below(4) as usize];
        let mut it = item(id, draw_cmds(tex, rng.next()));
        it.draw_index = id as i64;
        canvas.items.push(id);
        s.items.insert(id, it);
    }
    s.canvases.insert(1, canvas.clone());
    let vp = Viewport {
        width: 64,
        height: 32,
        clear: [0.0, 0.0, 0.0, 1.0],
        global_xform: geom::IDENTITY,
        cull_mask: 0xffff_ffff,
        format: Format::Rgb10A2,
    };
    let mut oracle = Applier::new(vp);
    oracle.always_scan_dependencies = true;
    let mut index = Applier::new(vp);
    index.skip_dep_textures = sabotage;
    let mut delta = TxDelta {
        full: true,
        canvases_upserted: vec![1],
        items_upserted: s.items.keys().copied().collect(),
        items_commands: s.items.keys().copied().collect(),
        textures_upserted: TEXTURES.to_vec(),
        ..TxDelta::default()
    };
    for step in 0..steps {
        let a = oracle.apply(&s, &delta, &store).clone();
        let b = index.apply(&s, &delta, &store).clone();
        let (mut a, mut b) = (a, b);
        a.walk_us = 0.0;
        a.assemble_us = 0.0;
        b.walk_us = 0.0;
        b.assemble_us = 0.0;
        if oracle.paint_digest() != index.paint_digest() || format!("{a:?}") != format!("{b:?}") {
            return Some(step);
        }
        oracle.list.consumed();
        index.list.consumed();
        delta = TxDelta::default();
        for _ in 0..1 + rng.below(3) {
            match rng.below(10) {
                // A texture changes size (a new payload, resident when drawn).
                0..=3 => {
                    let t = TEXTURES[rng.below(4) as usize];
                    put_texture(&mut s, &mut store, t, 4 + 4 * rng.below(4) as u32);
                    delta.textures_upserted.push(t);
                }
                // An item draws another texture.
                4..=5 => {
                    let ids: Vec<Id> = s.items.keys().copied().collect();
                    if let Some(&id) = ids.get(rng.below(ids.len().max(1) as u64) as usize) {
                        let tex = TEXTURES[rng.below(4) as usize];
                        let it = s.items.get_mut(&id).unwrap();
                        it.commands = draw_cmds(tex, rng.next());
                        it.content_version += 1;
                        delta.items_upserted.push(id);
                        delta.items_commands.push(id);
                    }
                }
                // An item goes, or a new one comes.
                6 => {
                    let ids: Vec<Id> = s.items.keys().copied().collect();
                    if ids.len() > 2 {
                        let id = ids[rng.below(ids.len() as u64) as usize];
                        s.items.remove(&id);
                        canvas.items.retain(|x| *x != id);
                        s.canvases.insert(1, canvas.clone());
                        delta.items_removed.push(id);
                        delta.canvases_upserted.push(1);
                    }
                }
                7 => {
                    let id = next_id;
                    next_id += 1;
                    let tex = TEXTURES[rng.below(4) as usize];
                    let mut it = item(id, draw_cmds(tex, rng.next()));
                    it.draw_index = id as i64;
                    canvas.items.push(id);
                    s.items.insert(id, it);
                    s.canvases.insert(1, canvas.clone());
                    delta.items_upserted.push(id);
                    delta.items_commands.push(id);
                    delta.canvases_upserted.push(1);
                }
                // A texture leaves the state (its drawers fall back), then returns later.
                8 => {
                    let t = TEXTURES[rng.below(4) as usize];
                    if s.textures.remove(&t).is_some() {
                        delta.textures_removed.push(t);
                    } else {
                        put_texture(&mut s, &mut store, t, 4 + 4 * rng.below(4) as u32);
                        delta.textures_upserted.push(t);
                    }
                }
                // Nothing a lowering reads.
                _ => {}
            }
        }
        delta.seq = step as i64 + 1;
    }
    None
}

#[test]
fn ph2_dependency_index_equals_full_scan() {
    for seed in 0..300 {
        assert_eq!(run(seed, 80, false), None, "seed {seed}");
    }
}

#[test]
fn ph2_skip_dep_texture_sabotage_is_caught() {
    let caught = (0..50).filter(|s| run(*s, 80, true).is_some()).count();
    assert!(caught >= 45, "the sabotage must fail (nearly) every run: {caught} of 50");
}

/// One random run of the named materials' textures (`Names::update`): materials whose texture
/// parameters and status change, items naming and un-naming them, shaders whose default
/// textures change, materials removed. The fast path is compared with `always_rebuild_materials`
/// after every update; `Some(step)` at the first difference.
fn names_run(seed: u64, steps: usize, sabotage: bool) -> Option<usize> {
    use super::residency::Names;
    let mut rng = Rng(seed.wrapping_mul(0x2545_f491_4f6c_dd1d) | 1);
    let mut s = ResolvedState::empty(6);
    let shader = |id: Id, tex: Id| Shader {
        id,
        origin: Origin::Created,
        status: EntryStatus::Ok,
        reason: None,
        version: 1,
        mode: None,
        source: None,
        hash: None,
        payload_bytes: 0,
        builtin: None,
        process: None,
        uses: Vec::new(),
        default_textures: vec![DefaultTexture {
            name: "d".into(),
            index: 0,
            tex,
        }],
    };
    let material = |rng: &mut Rng, id: Id| Material {
        id,
        origin: Origin::Created,
        status: if rng.below(8) == 0 {
            EntryStatus::Unsupported
        } else {
            EntryStatus::Ok
        },
        reason: None,
        version: 1,
        shader: Some(100 + rng.below(2) as Id),
        params: (0..rng.below(4))
            .map(|k| Param {
                name: format!("p{k}").into(),
                ty: VariantType::Rid,
                value: ParamValue::Tex(200 + rng.below(6) as Id),
            })
            .collect(),
    };
    for sid in [100, 101] {
        s.shaders.insert(sid, shader(sid, 300 + sid));
    }
    for mid in 1..=6 {
        let m = material(&mut rng, mid);
        s.materials.insert(mid, m);
    }
    for id in 10..18 {
        let mut it = item(id, Commands::default());
        it.material = Some(1 + rng.below(6) as Id);
        s.items.insert(id, it);
    }
    let (mut oracle, mut fast) = (Names::default(), Names::default());
    oracle.always_rebuild_materials = true;
    fast.skip_material_rebuild = sabotage;
    let mut delta = TxDelta::default();
    for step in 0..steps {
        let all = step == 0;
        oracle.update(&s, &delta, all);
        fast.update(&s, &delta, all);
        if oracle.all() != fast.all() || oracle.take_changed() != fast.take_changed() {
            return Some(step);
        }
        delta = TxDelta::default();
        for _ in 0..1 + rng.below(3) {
            let mid = 1 + rng.below(7) as Id;
            match rng.below(8) {
                // A material's texture parameters (or status, or shader) change; a seventh one
                // comes and goes.
                0..=3 => {
                    let m = material(&mut rng, mid);
                    s.materials.insert(mid, m);
                    delta.materials_upserted.push(mid);
                }
                4 => {
                    if s.materials.remove(&mid).is_some() {
                        delta.materials_removed.push(mid);
                    }
                }
                // An item names another material (or none).
                5 | 6 => {
                    let id = 10 + rng.below(8) as Id;
                    let it = s.items.get_mut(&id).unwrap();
                    it.material = (rng.below(4) != 0).then_some(mid);
                    delta.items_upserted.push(id);
                }
                // A shader's default texture changes.
                _ => {
                    let sid = 100 + rng.below(2) as Id;
                    s.shaders.insert(sid, shader(sid, 300 + rng.below(4) as Id));
                    delta.shaders_upserted.push(sid);
                }
            }
        }
        delta.materials_upserted.sort_unstable();
        delta.materials_upserted.dedup();
    }
    None
}

#[test]
fn ph2_named_material_textures_fast_path_equals_rebuild() {
    for seed in 0..300 {
        assert_eq!(names_run(seed, 120, false), None, "seed {seed}");
    }
}

#[test]
fn ph2_skip_material_textures_sabotage_is_caught() {
    let caught = (0..50).filter(|s| names_run(*s, 120, true).is_some()).count();
    assert!(caught >= 45, "the sabotage must fail (nearly) every run: {caught} of 50");
}
