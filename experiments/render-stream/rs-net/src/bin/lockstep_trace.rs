//! A minimal `tracing` subscriber for rs-net-lockstep `--trace FILE` (CAR10): every quinn event at
//! any level, one line each, with the enclosing spans' fields and the time since start. No
//! tracing-subscriber: that crate is not in the tree.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Metadata, Subscriber};

struct Fields(String);
impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let _ = write!(self.0, " {}={:?}", field.name(), value);
    }
}

pub struct Trace {
    start: Instant,
    next: AtomicU64,
    spans: Mutex<HashMap<u64, String>>,
    out: Mutex<std::io::BufWriter<std::fs::File>>,
}

thread_local! {
    static STACK: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
}

impl Trace {
    pub fn install(path: &str) {
        let t = Trace {
            start: Instant::now(),
            next: AtomicU64::new(1),
            spans: Mutex::new(HashMap::new()),
            out: Mutex::new(std::io::BufWriter::new(std::fs::File::create(path).expect("--trace file"))),
        };
        tracing::subscriber::set_global_default(t).expect("one subscriber");
    }
}

pub fn flush() {
    tracing::dispatcher::get_default(|d| {
        if let Some(t) = d.downcast_ref::<Trace>() {
            let _ = t.out.lock().unwrap().flush();
        }
    });
}

impl Subscriber for Trace {
    fn enabled(&self, m: &Metadata<'_>) -> bool {
        m.target().starts_with("quinn") || m.target().starts_with("wtransport")
    }
    fn new_span(&self, a: &Attributes<'_>) -> Id {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut f = Fields(a.metadata().name().to_string());
        a.record(&mut f);
        self.spans.lock().unwrap().insert(id, f.0);
        Id::from_u64(id)
    }
    fn record(&self, s: &Id, v: &Record<'_>) {
        if let Some(e) = self.spans.lock().unwrap().get_mut(&s.into_u64()) {
            let mut f = Fields(String::new());
            v.record(&mut f);
            e.push_str(&f.0);
        }
    }
    fn record_follows_from(&self, _s: &Id, _f: &Id) {}
    fn event(&self, e: &Event<'_>) {
        let mut f = Fields(String::new());
        e.record(&mut f);
        let ctx = STACK.with(|s| {
            let spans = self.spans.lock().unwrap();
            s.borrow().iter().filter_map(|i| spans.get(i).cloned()).collect::<Vec<_>>().join("/")
        });
        let line = format!(
            "{:.6} {} {} [{}]{}\n",
            self.start.elapsed().as_secs_f64(),
            e.metadata().level(),
            e.metadata().target(),
            ctx,
            f.0
        );
        let _ = self.out.lock().unwrap().write_all(line.as_bytes());
    }
    fn enter(&self, s: &Id) {
        STACK.with(|st| st.borrow_mut().push(s.into_u64()));
    }
    fn exit(&self, s: &Id) {
        STACK.with(|st| {
            let mut st = st.borrow_mut();
            if let Some(p) = st.iter().rposition(|x| *x == s.into_u64()) {
                st.remove(p);
            }
        });
    }
    fn try_close(&self, id: Id) -> bool {
        self.spans.lock().unwrap().remove(&id.into_u64());
        true
    }
}
