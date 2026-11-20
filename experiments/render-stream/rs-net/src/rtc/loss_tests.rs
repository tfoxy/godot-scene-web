//! Socket-free loss reproduction. The network queue drains once per virtual millisecond;
//! protocol time otherwise advances only to str0m deadlines. These are functional diagnostics,
//! not throughput measurements. Keep SCTP's own log messages alongside virtual timestamps.
use super::*;
use std::cell::Cell;
use std::collections::VecDeque;

thread_local! {
    static VIRTUAL_MS: Cell<u64> = const { Cell::new(0) };
}

struct SctpLog;
impl log::Log for SctpLog {
    fn enabled(&self, meta: &log::Metadata<'_>) -> bool {
        meta.target().starts_with("sctp_proto")
    }
    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let message = record.args().to_string();
        if [
            "(FR)", "(RTO)", "retrans", "RTO", "rto", "rwnd=0", "RECONFIG", "reset",
        ]
        .iter()
        .any(|needle| message.contains(needle))
        {
            eprintln!("{}", json!({"virtual_ms":VIRTUAL_MS.get(), "sctp":message}));
        }
    }
    fn flush(&self) {}
}

struct Network {
    queue: VecDeque<Vec<u8>>,
    bytes: usize,
    cap: usize,
    loss_per_mille: u64,
    random: u64,
    sent: u64,
    dropped: u64,
}
impl Network {
    fn new(cap: usize, loss_per_mille: u64) -> Self {
        Self {
            queue: VecDeque::new(),
            bytes: 0,
            cap,
            loss_per_mille,
            random: 0x12345678,
            sent: 0,
            dropped: 0,
        }
    }
    fn push(&mut self, bytes: &[u8]) {
        self.sent += 1;
        self.random ^= self.random << 13;
        self.random ^= self.random >> 7;
        self.random ^= self.random << 17;
        if self.bytes + bytes.len() > self.cap || self.random % 1000 < self.loss_per_mille {
            self.dropped += 1;
        } else {
            self.bytes += bytes.len();
            self.queue.push_back(bytes.to_vec());
        }
    }
    fn take(&mut self) -> VecDeque<Vec<u8>> {
        self.bytes = 0;
        std::mem::take(&mut self.queue)
    }
}

/// Both directions are impaired independently, with a fixed seed and bounded UDP-like queues.
/// Configure RS_RTC_SEND_BUFFER, RS_RTC_QUEUE_BYTES (default 212992), RS_RTC_LOSS_PER_MILLE
/// (default 0), and optionally RS_RTC_CHUNK_BYTES. Allow 120 s virtual time to distinguish
/// the browser harness's 10 s timeout from an association that eventually recovers.
#[test]
fn lossy_get_protocol_deadlines() {
    static LOGGER: SctpLog = SctpLog;
    log::set_logger(&LOGGER).expect("diagnostic owns the logger");
    log::set_max_level(log::LevelFilter::Trace);
    let setting =
        |key: &str, default: usize| std::env::var(key).map_or(default, |s| s.parse().unwrap());
    let cap = setting("RS_RTC_QUEUE_BYTES", 212_992);
    let loss = setting("RS_RTC_LOSS_PER_MILLE", 0) as u64;
    let chunks = std::env::var("RS_RTC_CHUNK_BYTES")
        .map(|s| vec![s.parse().unwrap()])
        .unwrap_or(vec![16_384, 65_536]);
    for chunk in chunks {
        VIRTUAL_MS.set(0);
        let mut p = Pair::new();
        let start = p.now;
        let id = p.create(LABEL);
        let mut up = Network::new(cap, loss);
        let mut down = Network::new(cap, loss);
        let mut requested = false;
        let mut delivered = 0;
        let mut ended = false;
        let mut close_started = None;
        let mut host_closed = false;
        let mut deadlines = 0;
        let mut next_report = 0;
        p.client.handle_input(Input::Timeout(p.now)).unwrap();
        // Poll after every delivered packet, so DTLS's internal receive queue never stands
        // in for the UDP queue. Outputs wait until the next network tick before delivery.
        let mut inbound_up: VecDeque<Vec<u8>> = VecDeque::new();
        let mut inbound_down: VecDeque<Vec<u8>> = VecDeque::new();
        for _ in 0..2_000_000 {
            let client_deadline = loop {
                match p.client.poll_output().unwrap() {
                    Output::Transmit(tx) => up.push(&tx.contents),
                    Output::Event(Event::ChannelOpen(open, _)) => p.opened.push(open),
                    Output::Event(Event::ChannelClose(closed)) => p.closed.push(closed),
                    Output::Event(Event::ChannelData(data)) => {
                        assert_eq!(data.id, id);
                        if data.binary {
                            for byte in &data.data {
                                assert_eq!(*byte, (delivered & 255) as u8);
                                delivered += 1;
                            }
                        } else {
                            assert_eq!(
                                serde_json::from_slice::<Value>(&data.data).unwrap(),
                                json!({"t":"end","n":8_388_608})
                            );
                            assert_eq!(delivered, 8_388_608);
                            ended = true;
                        }
                    }
                    Output::Event(_) => {}
                    Output::Timeout(deadline) => break deadline,
                }
            };
            let host_deadline = loop {
                match p.engine.poll_output() {
                    EngineOutput::Transmit(tx) => down.push(&tx.contents),
                    EngineOutput::Event(event) => {
                        assert_ne!(event["event"], "peer-error", "{event}");
                        host_closed |= event["detail"]["event"] == "channel-close";
                    }
                    EngineOutput::Timeout(deadline) => break deadline,
                }
            };
            if !requested && p.opened.contains(&id) {
                p.send(
                    id,
                    false,
                    json!({"t":"get","n":8_388_608,"c":chunk})
                        .to_string()
                        .as_bytes(),
                );
                requested = true;
                continue;
            }
            let elapsed = p.now.duration_since(start).as_millis() as u64;
            let closed = host_closed && p.closed.contains(&id);
            if elapsed >= next_report || (ended && close_started.is_none()) || closed {
                let mut buffered = 0;
                let mut generated = 0;
                if let Some(peer) = p.engine.peers.get_mut(&remote()) {
                    generated = peer.generated_get_bytes;
                    for id in peer.channels.keys() {
                        buffered += peer.rtc.channel(*id).unwrap().buffered_amount();
                    }
                }
                eprintln!(
                    "{}",
                    json!({"budget":send_budget(), "chunk":chunk,
                    "queue_bytes":cap, "loss_per_mille":loss, "virtual_ms":elapsed,
                    "delivered":delivered, "generated":generated, "buffered":buffered,
                    "host_datagrams":down.sent, "host_dropped":down.dropped,
                    "client_datagrams":up.sent, "client_dropped":up.dropped,
                    "deadlines":deadlines, "ended":ended, "closed":closed,
                    "close_ms":close_started.map(|start| elapsed - start)})
                );
                next_report = elapsed + 1000;
            }
            if closed {
                break;
            }
            if ended && close_started.is_none() {
                p.client.direct_api().close_data_channel(id);
                close_started = Some(elapsed);
                continue;
            }
            assert!(
                elapsed < 120_000,
                "no completion within 120 s virtual protocol time"
            );
            if let Some(bytes) = inbound_up.pop_front() {
                p.engine.receive(p.now, remote(), &bytes).unwrap();
                continue;
            }
            if let Some(bytes) = inbound_down.pop_front() {
                p.client
                    .handle_input(Input::Receive(
                        p.now,
                        Receive::new(Protocol::Udp, local(), remote(), &bytes).unwrap(),
                    ))
                    .unwrap();
                continue;
            }
            let network_deadline = (!up.queue.is_empty() || !down.queue.is_empty())
                .then_some(p.now + Duration::from_millis(1));
            let next = Some(client_deadline)
                .into_iter()
                .chain(host_deadline)
                .chain(network_deadline)
                .min()
                .expect("live deadline");
            assert!(next >= p.now, "deadline went backwards");
            p.now = next;
            VIRTUAL_MS.set(p.now.duration_since(start).as_millis() as u64);
            if Some(next) == network_deadline {
                inbound_up = up.take();
                inbound_down = down.take();
            }
            p.client.handle_input(Input::Timeout(p.now)).unwrap();
            p.engine.timeout(p.now);
            deadlines += 1;
        }
        assert!(ended, "pump did not complete");
        assert!(p.closed.contains(&id), "channel reset did not complete");
        assert!(host_closed, "remote channel close was not observed");
        assert!(
            up.dropped + down.dropped > 0 || loss == 0,
            "random-loss diagnostic must actually drop datagrams"
        );
    }
}
