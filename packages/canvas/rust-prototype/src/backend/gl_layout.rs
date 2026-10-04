//! The direct-GL backend's view of the scene shader, independent of the browser so it tests natively:
//! naga's GLSL for `shader.wgsl` (generated at build time, see `build.rs`) and the instance
//! attribute layout the vertex arrays describe.

/// naga's GLSL ES 3.00 translation of `shader.wgsl` for wgpu-hal's WebGL2 pipeline layout.
pub mod shaders {
    include!(concat!(env!("OUT_DIR"), "/gl_shaders.rs"));
}

/// Per-instance attributes of [`crate::geometry::Instance`]: (location, float components, byte offset).
pub const INSTANCE_ATTRIBUTES: [(u32, i32, i32); 13] = [
    (0, 4, 0),
    (1, 4, 16),
    (2, 4, 32),
    (3, 4, 48),
    (4, 4, 64),
    (5, 4, 80),
    (6, 4, 96),
    (7, 4, 112),
    (8, 4, 128),
    (9, 4, 144),
    (10, 2, 160),
    (11, 2, 168),
    (12, 2, 176),
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Instance;

    #[test]
    fn attribute_table_matches_the_instance_layout() {
        assert_eq!(std::mem::size_of::<Instance>(), 184);
        let probe = Instance {
            origin_axis_x: [0.0; 4],
            axis_y_uv_origin: [0.0; 4],
            uv_size_slot: [0.0; 4],
            color: [0.0; 4],
            matrix: [0.0; 12],
            clips: [[0.0; 4]; 3],
            clip_params: [[0.0; 2]; 3],
        };
        let base = &probe as *const Instance as usize;
        let offset = |p: *const f32| p as usize - base;
        let expected = [
            offset(probe.origin_axis_x.as_ptr()),
            offset(probe.axis_y_uv_origin.as_ptr()),
            offset(probe.uv_size_slot.as_ptr()),
            offset(probe.color.as_ptr()),
            offset(probe.matrix[0..].as_ptr()),
            offset(probe.matrix[4..].as_ptr()),
            offset(probe.matrix[8..].as_ptr()),
            offset(probe.clips[0].as_ptr()),
            offset(probe.clips[1].as_ptr()),
            offset(probe.clips[2].as_ptr()),
            offset(probe.clip_params[0].as_ptr()),
            offset(probe.clip_params[1].as_ptr()),
            offset(probe.clip_params[2].as_ptr()),
        ];
        for ((location, _, byte), want) in INSTANCE_ATTRIBUTES.iter().zip(expected) {
            assert_eq!(*byte as usize, want, "location {location}");
        }
    }

    /// The table must describe exactly the inputs naga declared for the vertex stage.
    #[test]
    fn attribute_table_matches_the_generated_vertex_inputs() {
        for (location, components, _) in INSTANCE_ATTRIBUTES {
            let declaration = format!(
                "layout(location = {location}) in vec{components} _p2vs_location{location};"
            );
            assert!(shaders::SCENE_VERT.contains(&declaration), "{declaration}");
        }
        assert!(!shaders::SCENE_VERT.contains("layout(location = 13) in"));
    }

    /// The generated program is wgpu-hal's: ES 3.00, naga's coordinate-space adjustment, the
    /// globals block and eight combined samplers on texture slots 0..7.
    #[test]
    fn generated_shaders_have_wgpu_hals_shape() {
        assert!(shaders::SCENE_VERT.starts_with("#version 300 es\n"));
        assert!(shaders::SCENE_VERT.contains(
            "gl_Position.yz = vec2(-gl_Position.y, gl_Position.z * 2.0 - gl_Position.w);"
        ));
        assert!(shaders::SCENE_VERT.contains(&format!("uniform {}", shaders::GLOBALS_BLOCK)));
        for (index, (name, slot)) in shaders::SCENE_TEXTURES.iter().enumerate() {
            assert_eq!(*slot as usize, index);
            assert!(shaders::SCENE_FRAG.contains(&format!("uniform highp sampler2D {name};")));
        }
    }
}
