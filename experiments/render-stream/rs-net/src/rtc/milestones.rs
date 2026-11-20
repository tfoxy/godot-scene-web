//! Observe SCTP establishment, which str0m does not expose as a public Event.
//! Keep this scoped to a single protocol call; never install a process-wide subscriber.
use std::fmt;
use std::sync::{Arc, Mutex};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Metadata, Subscriber};

#[derive(Clone, Default)]
struct SctpObserver(Arc<Mutex<bool>>);
impl Subscriber for SctpObserver {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.target() == "str0m::sctp" && *metadata.level() == tracing::Level::DEBUG
    }
    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }
    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn event(&self, event: &Event<'_>) {
        struct Message(bool);
        impl tracing::field::Visit for Message {
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn fmt::Debug) {
                if field.name() == "message" && format!("{value:?}").ends_with(" => Established") {
                    self.0 = true;
                }
            }
        }
        let mut message = Message(false);
        event.record(&mut message);
        if message.0 {
            *self.0.lock().unwrap() = true;
        }
    }
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}
}

pub(super) struct SctpTrace {
    subscriber: tracing::Dispatch,
    established: Arc<Mutex<bool>>,
}
impl Default for SctpTrace {
    fn default() -> Self {
        let observer = SctpObserver::default();
        Self {
            established: observer.0.clone(),
            subscriber: tracing::Dispatch::new(observer),
        }
    }
}
impl SctpTrace {
    pub(super) fn observe<R>(&self, f: impl FnOnce() -> R) -> (R, bool) {
        let result = tracing::dispatcher::with_default(&self.subscriber, f);
        let established = std::mem::take(&mut *self.established.lock().unwrap());
        (result, established)
    }
}
