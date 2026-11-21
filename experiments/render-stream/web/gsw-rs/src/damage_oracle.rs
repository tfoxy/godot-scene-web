//! Opt-in, independent full-redraw history and exact target comparison for replay tools.
use godot_scene_web_rust_prototype::canvas_items::{
    CanvasItemsExecutor, ExecError, ExecOptions, ExecStats,
};

pub struct Oracle {
    pub executor: CanvasItemsExecutor,
    pub compare: bool,
    pub primary_links: Vec<(u32, Result<(), String>)>,
    pub shadow_links: std::collections::HashMap<u32, Result<(), String>>,
    batching: u32,
    slot_calls: u64,
    frames: u64,
    partial: u64,
    full: u64,
    skipped: u64,
    mismatched: u64,
    history_reads: u64,
    first: Option<(u32, u32, usize, [usize; 4], u32, u32)>,
    primary: Vec<u8>,
    shadow: Vec<u8>,
    first_primary: Vec<u8>,
    first_shadow: Vec<u8>,
    modes: Vec<(u32, u32, u32)>,
}

impl Oracle {
    pub fn new(canvas: web_sys::HtmlCanvasElement, options: ExecOptions) -> Result<Self, String> {
        Ok(Self {
            executor: CanvasItemsExecutor::new(canvas, options)?,
            compare: true,
            primary_links: Vec::new(),
            shadow_links: Default::default(),
            batching: 0,
            slot_calls: 0,
            frames: 0,
            partial: 0,
            full: 0,
            skipped: 0,
            mismatched: 0,
            history_reads: 0,
            first: None,
            primary: Vec::new(),
            shadow: Vec::new(),
            first_primary: Vec::new(),
            first_shadow: Vec::new(),
            modes: Vec::new(),
        })
    }

    pub fn observe(
        &mut self,
        primary: &mut CanvasItemsExecutor,
        stats: &ExecStats,
        frame: u32,
        seq: u32,
        width: u32,
        height: u32,
    ) -> Result<(), ExecError> {
        if !self.compare {
            return Ok(());
        }
        self.batching = primary.options().batching;
        self.slot_calls += u64::from(stats.slot_calls);
        self.frames += 1;
        match stats.damage_mode {
            1 => self.full += 1,
            2 => self.partial += 1,
            3 => self.skipped += 1,
            _ => {}
        }
        self.history_reads += u64::from(primary.damage_history_reads());
        self.modes.push((frame, seq, stats.damage_mode));
        let w = width as usize;
        let h = height as usize;
        self.primary.resize(w * h * 4, 0);
        self.shadow.resize(w * h * 4, 0);
        primary.read_target(&mut self.primary)?;
        self.executor.read_target(&mut self.shadow)?;
        let mut pixels = 0;
        let mut bbox = [w, h, 0, 0];
        for (i, (a, b)) in self
            .primary
            .chunks_exact(4)
            .zip(self.shadow.chunks_exact(4))
            .enumerate()
        {
            if a != b {
                pixels += 1;
                bbox[0] = bbox[0].min(i % w);
                bbox[1] = bbox[1].min(i / w);
                bbox[2] = bbox[2].max(i % w + 1);
                bbox[3] = bbox[3].max(i / w + 1);
            }
        }
        if pixels != 0 {
            self.mismatched += 1;
            if self.first.is_none() {
                self.first = Some((frame, seq, pixels, bbox, width, height));
                self.first_primary.clone_from(&self.primary);
                self.first_shadow.clone_from(&self.shadow);
            }
        }
        Ok(())
    }

    pub fn shot(&self, shadow: bool) -> *const u8 {
        let bytes = if shadow {
            &self.first_shadow
        } else {
            &self.first_primary
        };
        if bytes.is_empty() {
            std::ptr::null()
        } else {
            bytes.as_ptr()
        }
    }

    pub fn json(&self) -> String {
        let first = self.first.map_or_else(|| "null".into(), |(frame, seq, pixels, bbox, width, height)| format!("{{\"frame\":{frame},\"seq\":{seq},\"pixels\":{pixels},\"bbox\":{:?},\"width\":{width},\"height\":{height}}}", bbox));
        let modes = self
            .modes
            .iter()
            .map(|(frame, seq, mode)| format!("[{frame},{seq},{mode}]"))
            .collect::<Vec<_>>()
            .join(",");
        format!("{{\"batching\":{},\"slot_calls\":{},\"frames\":{},\"partial\":{},\"full\":{},\"skipped\":{},\"mismatched\":{},\"first_mismatch\":{},\"damage_history_reads\":{},\"damage_modes\":[{}]}}", self.batching, self.slot_calls, self.frames, self.partial, self.full, self.skipped, self.mismatched, first, self.history_reads, modes)
    }
}
