//! `gl-backend` only: translate `src/shader.wgsl` to GLSL ES 3.00 with naga, using the options
//! wgpu-hal's WebGL2 backend uses for this shader's pipeline layout, so the direct-GL backend compiles
//! the same program text wgpu-hal compiles. Output: `$OUT_DIR/gl_shaders.rs`.
fn main() {
    println!("cargo:rerun-if-changed=src/shader.wgsl");
    println!("cargo:rerun-if-changed=build.rs");
    #[cfg(feature = "gl-backend")]
    gl::generate();
}

#[cfg(feature = "gl-backend")]
mod gl {
    use naga::back::glsl;
    use std::fmt::Write as _;

    /// The scene shader's pipeline layout as wgpu-hal maps it (`create_pipeline_layout`): group 0
    /// binding 0 is uniform buffer slot 0; group 1 bindings 0..7 are texture slots 0..7 and binding 8
    /// is sampler slot 0.
    fn binding_map() -> glsl::BindingMap {
        let mut map = glsl::BindingMap::default();
        map.insert(
            naga::ResourceBinding {
                group: 0,
                binding: 0,
            },
            0,
        );
        for binding in 0..8 {
            map.insert(naga::ResourceBinding { group: 1, binding }, binding as u8);
        }
        map.insert(
            naga::ResourceBinding {
                group: 1,
                binding: 8,
            },
            0,
        );
        map
    }

    struct Stage {
        source: String,
        /// (uniform name, texture slot) for every combined texture-sampler.
        textures: Vec<(String, u32)>,
        /// Uniform block names (one: the globals).
        blocks: Vec<String>,
    }

    fn translate(
        module: &naga::Module,
        info: &naga::valid::ModuleInfo,
        stage: naga::ShaderStage,
        entry: &str,
    ) -> Stage {
        // wgpu-hal on WebGL2: `Version::Embedded { 300, is_webgl }`; no shadow-LOD extension and no
        // draw parameters; coordinate-space adjustment and forced point size always.
        let options = glsl::Options {
            version: glsl::Version::Embedded {
                version: 300,
                is_webgl: true,
            },
            writer_flags: glsl::WriterFlags::ADJUST_COORDINATE_SPACE
                | glsl::WriterFlags::FORCE_POINT_SIZE,
            binding_map: binding_map(),
            zero_initialize_workgroup_memory: true,
        };
        let pipeline = glsl::PipelineOptions {
            shader_stage: stage,
            entry_point: entry.to_owned(),
            multiview: None,
        };
        let policies = naga::proc::BoundsCheckPolicies {
            index: naga::proc::BoundsCheckPolicy::Unchecked,
            buffer: naga::proc::BoundsCheckPolicy::Unchecked,
            image_load: naga::proc::BoundsCheckPolicy::Unchecked,
            binding_array: naga::proc::BoundsCheckPolicy::Unchecked,
        };
        let mut source = String::new();
        let mut writer =
            glsl::Writer::new(&mut source, module, info, &options, &pipeline, policies)
                .expect("glsl writer");
        let reflection = writer.write().expect("glsl translation");
        let mut textures: Vec<(String, u32)> = reflection
            .texture_mapping
            .iter()
            .map(|(name, mapping)| {
                let binding = module.global_variables[mapping.texture]
                    .binding
                    .as_ref()
                    .expect("texture binding");
                (name.clone(), binding.binding)
            })
            .collect();
        textures.sort();
        let mut blocks: Vec<String> = reflection.uniforms.values().cloned().collect();
        blocks.sort();
        Stage {
            source,
            textures,
            blocks,
        }
    }

    pub fn generate() {
        let wgsl = std::fs::read_to_string("src/shader.wgsl").expect("read shader.wgsl");
        let module = naga::front::wgsl::parse_str(&wgsl).expect("parse shader.wgsl");
        let info = naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        )
        .validate(&module)
        .expect("validate shader.wgsl");
        let vertex = translate(&module, &info, naga::ShaderStage::Vertex, "vs");
        let fragment = translate(&module, &info, naga::ShaderStage::Fragment, "fs");
        assert_eq!(vertex.blocks.len(), 1, "one uniform block (globals)");
        assert_eq!(fragment.textures.len(), 8, "eight combined samplers");
        let mut out = String::new();
        writeln!(
            out,
            "/// `vs` of `shader.wgsl`, as naga translates it for wgpu-hal on WebGL2."
        )
        .unwrap();
        writeln!(out, "pub const SCENE_VERT: &str = {:?};", vertex.source).unwrap();
        writeln!(
            out,
            "/// `fs` of `shader.wgsl`, as naga translates it for wgpu-hal on WebGL2."
        )
        .unwrap();
        writeln!(out, "pub const SCENE_FRAG: &str = {:?};", fragment.source).unwrap();
        writeln!(out, "/// The globals uniform block of the vertex stage.").unwrap();
        writeln!(
            out,
            "pub const GLOBALS_BLOCK: &str = {:?};",
            vertex.blocks[0]
        )
        .unwrap();
        writeln!(
            out,
            "/// Combined texture-sampler uniforms of the fragment stage, with their texture slot."
        )
        .unwrap();
        write!(out, "pub const SCENE_TEXTURES: [(&str, u32); 8] = [").unwrap();
        for (name, slot) in &fragment.textures {
            write!(out, "({name:?}, {slot}), ").unwrap();
        }
        writeln!(out, "];").unwrap();
        let path = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("gl_shaders.rs");
        std::fs::write(path, out).expect("write gl_shaders.rs");
    }
}
