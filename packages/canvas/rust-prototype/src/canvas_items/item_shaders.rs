/// The item-link GL seam: compile/link issue calls never read status.
pub(super) trait ShaderApi {
    type Shader: Copy;
    type Program: Copy;
    fn compile_stage(&self, vertex: bool, source: &str) -> Result<Self::Shader, String>;
    fn new_program(&self) -> Result<Self::Program, String>;
    fn attach(&self, program: Self::Program, shader: Self::Shader);
    fn link(&self, program: Self::Program);
    fn linked(&self, program: Self::Program) -> bool;
    fn program_log(&self, program: Self::Program) -> String;
    fn shader_log(&self, shader: Self::Shader) -> String;
    fn detach(&self, program: Self::Program, shader: Self::Shader);
    fn delete_stage(&self, shader: Self::Shader);
    fn delete_link(&self, program: Self::Program);
}

#[derive(Clone, Copy)]
pub(super) struct LinkShaders<S> {
    vertex: S,
    fragment: S,
    shared: bool,
}

/// The executor owns the builtin stage. A pending program borrows it until settlement or free.
pub(super) struct ItemShaders<S> {
    builtin: Option<S>,
    /// Read only on a failed link, once per context. Successful links query no shader status/log.
    builtin_log: Option<String>,
}

impl<S> Default for ItemShaders<S> {
    fn default() -> Self {
        Self {
            builtin: None,
            builtin_log: None,
        }
    }
}

impl<S: Copy> ItemShaders<S> {
    pub fn start<A: ShaderApi<Shader = S>>(
        &mut self,
        gl: &A,
        vertex: Option<&str>,
        builtin_source: &str,
        fragment: &str,
    ) -> Result<(A::Program, LinkShaders<S>), String> {
        let program = gl.new_program()?;
        let result = (|| {
            let v = match vertex {
                Some(source) => gl.compile_stage(true, source)?,
                None => match self.builtin {
                    Some(shader) => shader,
                    None => {
                        let shader = gl.compile_stage(true, builtin_source)?;
                        self.builtin = Some(shader);
                        shader
                    }
                },
            };
            let f = match gl.compile_stage(false, fragment) {
                Ok(shader) => shader,
                Err(e) => {
                    if vertex.is_some() {
                        gl.delete_stage(v);
                    }
                    return Err(e);
                }
            };
            gl.attach(program, v);
            gl.attach(program, f);
            gl.link(program);
            Ok(LinkShaders {
                vertex: v,
                fragment: f,
                shared: vertex.is_none(),
            })
        })();
        match result {
            Ok(shaders) => Ok((program, shaders)),
            Err(e) => {
                gl.delete_link(program);
                Err(e)
            }
        }
    }

    pub fn finish<A: ShaderApi<Shader = S>>(
        &mut self,
        gl: &A,
        program: A::Program,
        shaders: LinkShaders<S>,
    ) -> Result<A::Program, String> {
        let linked = gl.linked(program);
        let mut log = String::new();
        if !linked {
            log = gl.program_log(program);
            if shaders.shared {
                log.push_str(
                    self.builtin_log
                        .get_or_insert_with(|| gl.shader_log(shaders.vertex)),
                );
            } else {
                log.push_str(&gl.shader_log(shaders.vertex));
            }
            log.push_str(&gl.shader_log(shaders.fragment));
        }
        self.discard(gl, program, shaders);
        if linked {
            Ok(program)
        } else {
            gl.delete_link(program);
            Err(format!("canvas-items program link failed: {log}"))
        }
    }

    /// Detach only from this program; the shared stage remains owned by the executor.
    pub fn discard<A: ShaderApi<Shader = S>>(
        &self,
        gl: &A,
        program: A::Program,
        shaders: LinkShaders<S>,
    ) {
        gl.detach(program, shaders.vertex);
        gl.detach(program, shaders.fragment);
        if !shaders.shared {
            gl.delete_stage(shaders.vertex);
        }
        gl.delete_stage(shaders.fragment);
    }

    /// Lost-context handles must be forgotten without any calls into the restored context.
    pub fn forget_context(&mut self) {
        *self = Self::default();
    }

    pub fn delete<A: ShaderApi<Shader = S>>(&mut self, gl: &A) {
        if let Some(shader) = self.builtin.take() {
            gl.delete_stage(shader);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::{HashMap, HashSet};

    #[derive(Default)]
    struct Gl {
        next: Cell<u32>,
        compiled: RefCell<Vec<(u32, bool, String)>>,
        attached: RefCell<HashMap<u32, HashSet<u32>>>,
        deleted: RefCell<Vec<u32>>,
        failed: Cell<bool>,
        fail_create: Cell<Option<bool>>,
        logs: RefCell<Vec<u32>>,
        dead: RefCell<HashSet<u32>>,
    }
    impl Gl {
        fn id(&self) -> u32 {
            let n = self.next.get() + 1;
            self.next.set(n);
            n
        }
        fn live(&self, s: u32) {
            assert!(!self.dead.borrow().contains(&s), "dead shader {s}");
        }
    }
    impl ShaderApi for Gl {
        type Shader = u32;
        type Program = u32;
        fn compile_stage(&self, vertex: bool, source: &str) -> Result<u32, String> {
            if self.fail_create.get() == Some(vertex) {
                return Err("create failed".into());
            }
            let s = self.id();
            self.compiled.borrow_mut().push((s, vertex, source.into()));
            Ok(s)
        }
        fn new_program(&self) -> Result<u32, String> {
            Ok(self.id())
        }
        fn attach(&self, p: u32, s: u32) {
            self.live(s);
            self.attached.borrow_mut().entry(p).or_default().insert(s);
        }
        fn link(&self, _: u32) {}
        fn linked(&self, _: u32) -> bool {
            !self.failed.get()
        }
        fn program_log(&self, _: u32) -> String {
            "program log;".into()
        }
        fn shader_log(&self, s: u32) -> String {
            self.live(s);
            self.logs.borrow_mut().push(s);
            format!("shader {s} log;")
        }
        fn detach(&self, p: u32, s: u32) {
            self.live(s);
            assert!(self.attached.borrow_mut().get_mut(&p).unwrap().remove(&s));
        }
        fn delete_stage(&self, s: u32) {
            self.live(s);
            assert!(!self.deleted.borrow().contains(&s), "double delete {s}");
            self.deleted.borrow_mut().push(s);
        }
        fn delete_link(&self, p: u32) {
            self.attached.borrow_mut().remove(&p);
        }
    }
    fn start(
        cache: &mut ItemShaders<u32>,
        gl: &Gl,
        vertex: Option<&str>,
    ) -> (u32, LinkShaders<u32>) {
        cache.start(gl, vertex, "VERT", "FRAG").unwrap()
    }

    #[test]
    fn many_item_links_compile_one_builtin_and_no_success_logs() {
        let gl = Gl::default();
        let mut cache = ItemShaders::default();
        let links: Vec<_> = (0..12).map(|_| start(&mut cache, &gl, None)).collect();
        assert_eq!(
            gl.compiled.borrow().iter().filter(|(_, v, _)| *v).count(),
            1
        );
        assert_eq!(gl.compiled.borrow().len(), 13);
        let shared = links[0].1.vertex;
        for (p, s) in links {
            cache.finish(&gl, p, s).unwrap();
        }
        assert!(gl.logs.borrow().is_empty());
        assert!(!gl.deleted.borrow().contains(&shared));
        assert_eq!(gl.deleted.borrow().len(), 12);
        cache.delete(&gl);
        cache.delete(&gl);
        assert_eq!(
            gl.deleted.borrow().iter().filter(|s| **s == shared).count(),
            1
        );
    }

    #[test]
    fn failure_and_free_preserve_other_links_and_cache_vertex_log() {
        let gl = Gl::default();
        let mut cache = ItemShaders::default();
        let a = start(&mut cache, &gl, None);
        let b = start(&mut cache, &gl, None);
        let c = start(&mut cache, &gl, None);
        let d = start(&mut cache, &gl, None);
        gl.failed.set(true);
        for (p, s) in [a, b] {
            let log = cache.finish(&gl, p, s).unwrap_err();
            assert!(log.contains("program log;"));
            assert!(log.contains(&format!("shader {} log;", s.vertex)));
            assert!(log.contains(&format!("shader {} log;", s.fragment)));
            assert!(!gl.attached.borrow().contains_key(&p));
        }
        cache.discard(&gl, c.0, c.1);
        gl.delete_link(c.0);
        assert!(gl.attached.borrow()[&d.0].contains(&d.1.vertex));
        assert!(!gl.deleted.borrow().contains(&d.1.vertex));
        assert_eq!(
            gl.logs
                .borrow()
                .iter()
                .filter(|s| **s == d.1.vertex)
                .count(),
            1
        );
        gl.failed.set(false);
        cache.finish(&gl, d.0, d.1).unwrap();
        cache.delete(&gl);
    }

    #[test]
    fn restore_recreates_builtin_without_touching_old_handles() {
        let gl = Gl::default();
        let mut cache = ItemShaders::default();
        let old = start(&mut cache, &gl, None);
        gl.failed.set(true);
        cache.finish(&gl, old.0, old.1).unwrap_err();
        let pending = start(&mut cache, &gl, None);
        gl.dead
            .borrow_mut()
            .extend([old.1.vertex, old.1.fragment, pending.1.fragment]);
        cache.forget_context();
        let restored = start(&mut cache, &gl, None);
        assert_ne!(restored.1.vertex, old.1.vertex);
        cache.finish(&gl, restored.0, restored.1).unwrap_err();
        assert!(gl.logs.borrow().contains(&restored.1.vertex));
        cache.delete(&gl);
        assert_eq!(
            gl.compiled.borrow().iter().filter(|(_, v, _)| *v).count(),
            2
        );
    }

    #[test]
    fn custom_vertices_are_owned_including_on_failure_and_free() {
        let gl = Gl::default();
        let mut cache = ItemShaders::default();
        for failed in [false, true] {
            let (p, s) = start(&mut cache, &gl, Some("CUSTOM"));
            gl.failed.set(failed);
            assert_eq!(cache.finish(&gl, p, s).is_err(), failed);
            assert!(gl.deleted.borrow().contains(&s.vertex));
            assert!(gl.deleted.borrow().contains(&s.fragment));
        }
        let (p, s) = start(&mut cache, &gl, Some("CUSTOM"));
        cache.discard(&gl, p, s);
        gl.delete_link(p);
        assert!(gl.deleted.borrow().contains(&s.vertex));
        assert_eq!(
            gl.compiled.borrow().iter().filter(|(_, v, _)| *v).count(),
            3
        );
        assert!(cache.builtin.is_none());
    }

    #[test]
    fn allocation_failure_deletes_owned_stages_but_retains_shared_stage() {
        for vertex in [None, Some("CUSTOM")] {
            let gl = Gl::default();
            let mut cache = ItemShaders::default();
            gl.fail_create.set(Some(false));
            assert!(cache.start(&gl, vertex, "VERT", "FRAG").is_err());
            assert_eq!(gl.deleted.borrow().len(), usize::from(vertex.is_some()));
            gl.fail_create.set(None);
            let (p, s) = start(&mut cache, &gl, vertex);
            cache.finish(&gl, p, s).unwrap();
            cache.delete(&gl);
        }
    }
}
