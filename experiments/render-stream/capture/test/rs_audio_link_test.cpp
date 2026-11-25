#include "rs_audio_hub.h"
#include "rs_json_lite.h"
#include <algorithm>
#include <atomic>
#include <barrier>
#include <cstdio>
#include <future>
#include <fstream>
namespace a = grc::audio;
namespace j = grc::rs::json_lite;
unsigned checks = 0, failures = 0;
void check(bool ok, const char *name) { ++checks; if (!ok) { ++failures; std::fprintf(stderr, "FAIL: %s\n", name); } }
struct Fake : grc::rs2::LiveTransport {
  struct Message { unsigned conn; std::string text; a::Bytes bytes; };
  std::vector<Message> messages;
  bool send_binary(unsigned c, a::Bytes b) override { messages.push_back({c, {}, std::move(b)}); return true; }
  bool send_text(unsigned c, std::string t) override { messages.push_back({c, std::move(t), {}}); return true; }
  void close(unsigned, std::uint16_t, std::string) override {}
  std::uint64_t queued_bytes(unsigned) const override { return 0; }
  std::uint64_t max_queued_bytes(unsigned) const override { return 0; }
  unsigned texts(unsigned conn, const std::string &type) const {
    unsigned count = 0;
    for (const auto &m : messages) if (m.conn == conn && m.text.starts_with("{\"type\":\"" + type + "\"")) ++count;
    return count;
  }
  unsigned blocks(unsigned conn) const { unsigned n = 0; for (const auto &m : messages) n += m.conn == conn && !m.bytes.empty(); return n; }
};
struct Host {
  std::vector<a::LinkMessage> messages;
  bool accept = true;
  static int output(void *self, const std::uint8_t *msg, std::size_t len) {
    auto &h = *static_cast<Host *>(self); h.messages.push_back(a::decode_link(a::Bytes(msg, msg + len))); return h.accept;
  }
  int attach() { grc_audio_link_v1 api{1, sizeof(grc_audio_link_v1), this, output}; return grc_audio_link_attach_v1(&api); }
  unsigned count(unsigned type) const { unsigned n = 0; for (const auto &m : messages) n += m.type == type; return n; }
};
int input(const a::LinkMessage &m) { const auto bytes = a::encode_link(m); return grc_audio_link_in(bytes.data(), bytes.size()); }
a::LinkMessage hello() {
  a::LinkMessage m; m.clock_domain = a::clock_domain(); m.bankset = std::string(32, '1'); m.lanes = {{1,"music","Music"},{2,"sfx","SFX"}}; return m;
}
std::string state(a::Hub &h, const char *field) {
  j::JValue v; if (!j::Reader(h.json()).parse(&v)) return "invalid";
  return v.get("link")->get(field)->text;
}
int main() {
  check(a::boot_clock_domain("darwin",123456789)=="9b55f64b336f574d0c47090f55faf488" &&
      a::boot_clock_domain("windows",123456789)=="cad0a973714e52ba943ba5b28b2e1459",
      "boot-domain SHA256 prefixes include tagged NULs and u64le seconds");
#if defined(__linux__)
  std::ifstream boot("/proc/sys/kernel/random/boot_id"); std::string raw; boot >> raw;
  std::string expected; for (char c : raw) if (c!='-') expected+=c;
  check(a::clock_domain()==expected && expected.size()==32,"Linux domain is raw kernel boot_id bytes");
#endif
  check(grc_audio_link_attach_v1(nullptr) == 0 && grc_audio_link_in(nullptr, 0) == 0, "ungranted endpoints return zero");
  grc_audio_cue_v1 cue{}; grc_audio_cue_get_v1(&cue);
  const std::string key = "event:/link-test"; std::uint8_t id[16]; cue.key_id(key.data(), key.size(), id);
  const auto kid = a::key_id(key);
  {
    Fake t; a::Hub hub({}, t, false, false, false); cue.groups(nullptr, 0, 1);
    Host host;
    grc_audio_link_v1 bad{2, sizeof(grc_audio_link_v1), &host, Host::output};
    check(grc_audio_link_attach_v1(&bad) == -1, "wrong ABI refused");
    bad.abi_version = 1; bad.size = sizeof(bad) - 1;
    check(grc_audio_link_attach_v1(&bad) == -1, "short table refused");
    bad.size = sizeof(bad); bad.link_out = nullptr;
    check(grc_audio_link_attach_v1(&bad) == -1, "null callback refused");
    check(host.attach() == 1 && state(hub, "state") == "connecting", "attach connecting");
    hub.drain_cues();
    check(host.count(0) == 1 && host.messages[0].clock_domain == a::clock_domain() &&
        host.messages[0].bankset == std::string(32, '0') && host.messages[0].lanes.empty(), "seat hello uses boot clock and zero bankset");
    for (unsigned conn : {1,2}) { hub.sender().add(conn); hub.opened(conn); }
    cue.cue(1, id, key.data(), key.size(), "SFX", 3, 123, 1, 1); hub.drain_cues(); hub.sender().frame();
    check(t.texts(1,"cue") == 1 && t.texts(2,"cue") == 1 && t.texts(1,"take-unavailable") == 1 && host.count(5) == 0,
        "connecting sends cue and immediate unavailable without queuing want");
    check(input(hello()) == 1 && state(hub,"state") == "up", "host hello connects");
    // Metadata changes invalidate the connecting clients' handshake. Reconnect
    // them before the ordinary relay checks below.
    hub.sender().frame(); hub.sender().take_closes();
    for (unsigned conn : {1,2}) { hub.removed(conn); hub.sender().add(conn); hub.ready(); hub.opened(conn); }
    check(hub.message(1, "{\"type\":\"have\",\"bankset\":\"" + std::string(32,'1') + "\",\"key_ids\":[\"" + kid + "\"],\"reset\":true}"), "warm client have accepted");
    hub.sender().frame(); t.messages.clear();
    std::array<std::thread,8> producers; std::barrier start(8); std::atomic<unsigned> refused{0};
    for (auto &p : producers) p = std::thread([&] {
      start.arrive_and_wait(); for (unsigned n = 0; n < 32; ++n)
        if (cue.cue(1,id,key.data(),key.size(),"SFX",3,123+n,1,1) != 1) ++refused;
    });
    for (auto &p : producers) p.join();
    hub.drain_cues(); hub.sender().frame();
    check(refused == 0 && host.count(5) == 1, "256 concurrent cues dedupe to one want");
    check(t.texts(1,"cue") == 256 && t.texts(2,"cue") == 256, "cues go to warm and cold clients");
    auto want = host.messages.back();
    check(want.type == 5 && want.key == key && want.key_id == kid && want.t_us >= 123, "want preserves cue identity and capture time");
    a::LinkMessage m; m.type = 2; m.key_id = kid; m.stream = 9; m.frames = 1024;
    check(input(m) == 1, "take-start accepted");
    for (unsigned n = 0; n < 2; ++n) {
      a::Block b; b.header.stream=9; b.header.block=n; b.header.frames=512; b.header.flags=n?2:1;
      b.header.made_us=a::now_us(); b.header.due_us=b.header.made_us; b.payload.resize(2048);
      m = {}; m.type=1; m.block=a::encode_block(b.header,b.payload); check(input(m)==1,"take block accepted");
    }
    m={}; m.type=3; m.key_id=kid; m.stream=9; m.wav_sha256=std::string(64,'a');
    check(input(m)==1,"ready accepted"); hub.sender().frame();
    check(t.texts(1,"take-start")==0 && t.texts(1,"take-ready")==0 && t.blocks(1)==0 &&
        t.texts(2,"take-start")==1 && t.texts(2,"take-ready")==1 && t.blocks(2)==2,"take relayed only to lacking connection");
    std::string order; for (const auto &v:t.messages) if (v.conn==2) {
      if (!v.bytes.empty()) { auto b=a::decode_block(v.bytes); check(b.header.sent_us>0,"seat stamps block"); order+='B'; }
      else if (v.text.starts_with("{\"type\":\"take-start\"")) order+='S';
      else if (v.text.starts_with("{\"type\":\"take-ready\"")) order+='R';
    }
    check(order=="SBBR","ready follows last block at carrier");
    check(hub.message(1,"{\"type\":\"lanes\",\"ids\":[1]}") && hub.message(2,"{\"type\":\"lanes\",\"ids\":[2]}"),"lane subscriptions accepted");
    hub.drain_cues(); check(host.messages.back().type==6 && host.messages.back().lane_mask==6,"link carries union over connections");
    const grc_audio_gain mute{"Music",5,-0.0f}; cue.groups(&mute,1,0); hub.drain_cues();
    check(host.messages.back().lane_mask==4,"zero group gain unsubscribes lane");
    hub.removed(2); hub.drain_cues(); check(host.messages.back().lane_mask==0,"disconnect removes lane from union");
    cue.groups(nullptr,0,1); hub.drain_cues();
    check(host.messages.back().lane_mask==2,"group snapshot restores subscription");
    check(hub.message(1,"{\"type\":\"have\",\"bankset\":\""+std::string(32,'2')+"\",\"key_ids\":[\""+kid+"\"],\"reset\":true}"),"foreign bankset accepted as cold");
    cue.cue(1,id,key.data(),key.size(),"SFX",3,123,1,1); hub.drain_cues();
    check(host.count(5)==2,"foreign bankset does not suppress want");
    check(grc_audio_link_attach_v1(nullptr)==1 && state(hub,"state")=="detached","detach synchronizes");
    const auto count=host.messages.size(); hub.drain_cues(); hub.sender().frame();
    check(host.messages.size()==count && t.texts(1,"take-unavailable")==1,"detach cancels pending take and prevents callbacks");
    bool unavailable=false; for (const auto &v:t.messages) unavailable |= v.text.find("\"state\":\"unavailable\"")!=std::string::npos;
    check(unavailable,"link-down makes lanes unavailable");
    check(grc_audio_link_in(nullptr,0)==0,"detached input returns zero");
    host.attach(); hub.drain_cues(); auto wrong=hello(); wrong.clock_domain=std::string(32,'f');
    check(input(wrong)==-1 && state(hub,"reason")=="clock-domain","clock mismatch fails closed");
    check(input(hello())==-1,"down remains down until attach");
    host.attach(); hub.drain_cues(); check(input(hello())==1,"reattach recovers");
    check(input(hello())==-1 && state(hub,"reason")=="link-protocol","duplicate hello fails protocol");
    host.attach(); hub.drain_cues(); input(hello());
    const std::uint8_t junk=255;
    check(grc_audio_link_in(&junk,1)==-1 && state(hub,"reason")=="link-protocol","malformed message fails protocol");
    host.attach(); host.accept=false; hub.drain_cues();
    check(state(hub,"state")=="down" && state(hub,"reason")=="link-down","callback refusal sets link down");
    grc_audio_link_attach_v1(nullptr);
  }
  {
    Fake t; a::Hub hub({},t,false,false,false); cue.groups(nullptr,0,1);
    Host host; host.attach(); hub.drain_cues(); input(hello());
    hub.sender().add(10); hub.opened(10);
    const auto fire = [&] { cue.cue(1,id,key.data(),key.size(),"SFX",3,123,1,1); hub.drain_cues(); };
    const auto start = [&](unsigned stream) {
      a::LinkMessage m; m.type=2; m.key_id=kid; m.stream=stream; m.frames=1024; return input(m);
    };
    const auto block = [&](unsigned stream, unsigned n) {
      a::Block b; b.header.stream=stream; b.header.block=n; b.header.frames=512; b.header.flags=n?2:1;
      b.payload.resize(2048); a::LinkMessage m; m.type=1; m.block=a::encode_block(b.header,b.payload); return input(m);
    };
    const auto ready = [&](unsigned stream) {
      a::LinkMessage m; m.type=3; m.key_id=kid; m.stream=stream; m.wav_sha256=std::string(64,'a'); return input(m);
    };
    fire(); start(100); block(100,0); hub.sender().frame();
    for (unsigned conn : {11,12,13}) { hub.sender().add(conn); hub.opened(conn); }
    // A closing or already warmed late client must not trigger another relay.
    hub.removed(12);
    hub.message(13,"{\"type\":\"have\",\"bankset\":\""+std::string(32,'1')+"\",\"key_ids\":[\""+kid+"\"],\"reset\":true}");
    fire(); fire();
    block(100,1); ready(100); hub.drain_cues(); hub.sender().frame();
    check(t.blocks(11)==0 && t.texts(11,"take-start")==0 && t.texts(11,"take-ready")==0,
        "late client never receives partial take");
    check(host.count(5)==2,"late clients dedupe to one new want after ready");
    start(101); block(101,0); block(101,1); ready(101); hub.drain_cues(); hub.sender().frame();
    check(t.blocks(10)==2 && t.blocks(11)==2 && t.blocks(12)==0 && t.blocks(13)==0 &&
        t.texts(11,"take-start")==1 && t.texts(11,"take-ready")==1 && host.count(5)==2,
        "second complete take relays only to pending cold clients");
    fire(); start(102);
    hub.sender().add(14); hub.opened(14); fire();
    a::LinkMessage unavailable; unavailable.type=4; unavailable.key_id=kid; unavailable.reason=2;
    input(unavailable); hub.drain_cues(); hub.sender().frame();
    check(host.count(5)==4 && t.texts(14,"take-unavailable")==0,
        "unavailable completes fixed relay set and requests pending clients");
    grc_audio_link_attach_v1(nullptr); hub.sender().frame();
    check(t.texts(14,"take-unavailable")==1,"detach also cancels pending replacement take");
  }
  for (bool warming_have : {false,true}) {
    Fake t; a::Hub hub({},t,false,false,false); cue.groups(nullptr,0,1);
    Host host; host.attach(); hub.drain_cues(); input(hello());
    hub.sender().add(15); hub.opened(15);
    const auto fire=[&] { cue.cue(1,id,key.data(),key.size(),"SFX",3,123,1,1); hub.drain_cues(); };
    fire();
    check(host.count(5)==1,"cold key dispatches one want before recipient changes");
    if (warming_have) {
      check(hub.message(15,"{\"type\":\"have\",\"bankset\":\""+std::string(32,'1')+
          "\",\"key_ids\":[\""+kid+"\"],\"reset\":true}"),"only recipient warms before take-start");
    } else hub.removed(15);
    check(state(hub,"pending")=="1",warming_have ?
        "warming have retains dispatched want until terminal reply" :
        "closing last recipient retains dispatched want until terminal reply");
    hub.sender().add(16); hub.opened(16); fire();
    check(host.count(5)==1,warming_have ?
        "cold cue after warming have joins dispatched want" :
        "cold cue after reconnect joins dispatched want");
    a::LinkMessage m; m.type=2; m.key_id=kid; m.stream=150; m.frames=1024;
    check(input(m)==1,"dispatched take-start accepted after recipient replacement");
    for (unsigned n=0;n<2;++n) {
      a::Block b; b.header.stream=150; b.header.block=n; b.header.frames=512; b.header.flags=n?2:1;
      b.payload.resize(2048); m={}; m.type=1; m.block=a::encode_block(b.header,b.payload);
      check(input(m)==1,"dispatched take block accepted after recipient replacement");
    }
    m={}; m.type=3; m.key_id=kid; m.stream=150; m.wav_sha256=std::string(64,'a');
    check(input(m)==1,"dispatched take-ready accepted after recipient replacement");
    hub.drain_cues(); hub.sender().frame();
    check(host.count(5)==1 && state(hub,"state")=="up" && state(hub,"pending")=="0",
        "one dispatched want completes without duplicate or link down");
    check(t.texts(16,"take-start")==1 && t.blocks(16)==2 && t.texts(16,"take-ready")==1 &&
        t.texts(16,"take-unavailable")==0,"replacement cold connection receives whole take without unavailable");
    check(t.texts(15,"take-start")==0 && t.blocks(15)==0 && t.texts(15,"take-ready")==0,
        "closed or warmed original recipient receives no take");
  }
  for (bool warming_have : {false,true}) {
    // Pump Link directly to leave the want queued, before any link_out callback.
    Fake t; a::Sender sender({},t,false); a::Link link(sender); Host host;
    host.attach(); link.drain(); input(hello()); sender.add(17);
    link.opened(17,[](const auto &,const auto &) {});
    a::CueRecord record{}; record.kind=1; record.key_len=key.size(); record.t_us=123;
    std::copy(key.begin(),key.end(),record.key.begin()); std::copy_n(id,16,record.key_id.begin());
    link.cue(record);
    check(host.count(5)==0,"queued want has not reached host callback");
    if (warming_have) link.have(17,std::string(32,'1'),{kid});
    else link.removed(17);
    link.drain();
    grc::JsonWriter evidence; link.evidence(evidence); j::JValue v;
    check(j::Reader(evidence.take()).parse(&v) && v.get("pending")->text=="0" && host.count(5)==0,
        warming_have ? "warming have cancels undrained want and empty entry" :
        "closing last recipient cancels undrained want and empty entry");
    sender.add(18); link.opened(18,[](const auto &,const auto &) {}); link.cue(record); link.drain();
    check(host.count(5)==1,"cold cue after queued cancellation sends one fresh want");
  }
  {
    Fake t; a::Hub hub({},t,false,false,false); Host host;
    host.attach(); hub.drain_cues(); auto zero=hello(); zero.clock_domain=std::string(32,'0');
    check(input(zero)==-1 && state(hub,"reason")=="clock-domain","zero peer clock domain is mismatch");
    host.attach(); hub.drain_cues(); auto names=hello();
    names.lanes[0].name=std::string(127,'x')+"\xE2\x82\xAC";
    names.lanes[1].name=std::string(100,'\n');
    check(input(names)==1,"long lane diagnostics accepted");
    j::JValue v;
    // ready() returns a suffix, so inspect it through an object envelope.
    check(j::Reader("{\"type\":\"track-ready\""+hub.ready()).parse(&v) &&
        v.get("lanes")->items[0].get("name")->text==std::string(127,'x') &&
        v.get("lanes")->items[1].get("name")->text==std::string(64,'\n'),
        "lane names truncate at UTF-8 boundary within 128 escaped bytes");
    grc_audio_link_attach_v1(nullptr);
  }
  {
    Fake t; a::Hub hub({},t,false,false,false); cue.groups(nullptr,0,1);
    Host host; host.attach(); hub.drain_cues(); input(hello());
    hub.sender().add(20); hub.opened(20);
    const auto fire=[&] { cue.cue(1,id,key.data(),key.size(),"SFX",3,123,1,1); hub.drain_cues(); };
    const auto have=[&](bool warm) {
      return hub.message(20,"{\"type\":\"have\",\"bankset\":\""+std::string(32,'1')+"\",\"key_ids\":["+
          (warm?"\""+kid+"\"":"")+"],\"reset\":true}");
    };
    fire(); have(true);
    a::LinkMessage m; m.type=2; m.key_id=kid; m.stream=200; m.frames=512; input(m);
    have(false); fire();
    a::Block b; b.header.stream=200; b.header.flags=3; b.header.frames=512; b.payload.resize(2048);
    m={}; m.type=1; m.block=a::encode_block(b.header,b.payload); input(m);
    m={}; m.type=3; m.key_id=kid; m.stream=200; m.wav_sha256=std::string(64,'a'); input(m);
    hub.drain_cues(); hub.sender().frame();
    check(t.texts(20,"take-start")==0 && t.texts(20,"take-ready")==0 && t.blocks(20)==0 && host.count(5)==2,
        "have reset after take-start waits for a new complete take");
    grc_audio_link_attach_v1(nullptr);
  }
  {
    Fake t; a::Hub hub({},t,false,false,false); cue.groups(nullptr,0,1);
    Host host; host.attach(); hub.drain_cues(); input(hello());
    hub.sender().add(30); hub.opened(30); hub.sender().frame(); t.messages.clear();
    cue.cue(1,id,key.data(),key.size(),"SFX",3,123,1,1); hub.drain_cues();
    a::LinkMessage m; m.type=2; m.key_id=kid; m.stream=300; m.frames=1024; input(m);
    for (unsigned n=0;n<2;++n) {
      a::Block b; b.header.stream=300; b.header.block=n; b.header.frames=512; b.header.flags=n?6:5;
      m={}; m.type=1; m.block=a::encode_block(b.header,b.payload);
      check(input(m)==1,"silent take block accepted, including final block");
    }
    hub.sender().frame();
    check(t.blocks(30)==1 && t.texts(30,"take-ready")==0,"silent final block held until ready");
    m={}; m.type=3; m.key_id=kid; m.stream=300; m.wav_sha256=std::string(64,'a'); input(m);
    hub.sender().frame(); std::string order;
    for (const auto &v:t.messages) if (v.conn==30) {
      if (!v.bytes.empty()) { auto b=a::decode_block(v.bytes);
        check((b.header.flags&4) && b.payload.empty(),"relayed silent block retains flag and zero payload"); order+='B';
      } else if (v.text.starts_with("{\"type\":\"take-ready\"")) order+='R';
    }
    check(order=="BBR" && state(hub,"state")=="up","silent final block precedes ready without link down");
    t.messages.clear();
    cue.cue(1,id,key.data(),key.size(),"SFX",3,123,1,1); hub.drain_cues();
    m={}; m.type=2; m.key_id=kid; m.stream=302; m.frames=512; input(m);
    a::Block single; single.header.stream=302; single.header.frames=512; single.header.flags=7;
    m={}; m.type=1; m.block=a::encode_block(single.header,single.payload);
    check(input(m)==1,"single first-last-silent block accepted");
    m={}; m.type=3; m.key_id=kid; m.stream=302; m.wav_sha256=std::string(64,'a'); input(m); hub.sender().frame();
    bool silent=false; for (const auto &v:t.messages) if (!v.bytes.empty()) {
      const auto b=a::decode_block(v.bytes); silent=b.header.flags==7 && b.payload.empty();
    }
    check(silent && t.texts(30,"take-ready")==1 && state(hub,"state")=="up","single silent take relayed intact and link stays up");
  }
  {
    Fake t; a::Hub hub({},t,false,false,false); cue.groups(nullptr,0,1);
    Host host; host.attach(); hub.drain_cues(); input(hello());
    hub.sender().add(31); hub.opened(31);
    bool bounded=true;
    for (unsigned n=0;n<a::Link::pending_relay_limit+6;++n) {
      const auto key="event:/overflow-"+std::to_string(n); std::uint8_t id[16]; cue.key_id(key.data(),key.size(),id);
      cue.cue(1,id,key.data(),key.size(),"SFX",3,123,1,1);
      hub.drain_cues(); hub.sender().frame();
      bounded &= std::stoul(state(hub,"pending"))<=a::Link::pending_relay_limit;
    }
    const auto closes=hub.sender().take_closes();
    check(closes.size()==1 && closes[0].conn==31 && closes[0].code==1013 && closes[0].reason=="audio-overflow",
        "pending relay overflow resync closes affected connection");
    check(bounded && state(hub,"pending")=="0" && state(hub,"state")=="up",
        "pending relay remains bounded and overflow preserves link");
    hub.removed(31); hub.sender().add(32); hub.opened(32);
    cue.cue(1,id,key.data(),key.size(),"SFX",3,123,1,1); hub.drain_cues(); hub.removed(32);
    check(state(hub,"pending")=="1","last recipient removal retains dispatched relay");
    a::LinkMessage m; m.type=2; m.key_id=kid; m.stream=301; m.frames=512;
    bool accepted=input(m)==1;
    a::Block b; b.header.stream=301; b.header.frames=512; b.header.flags=7;
    m={}; m.type=1; m.block=a::encode_block(b.header,b.payload); accepted &= input(m)==1;
    m={}; m.type=3; m.key_id=kid; m.stream=301; m.wav_sha256=std::string(64,'a'); accepted &= input(m)==1;
    check(accepted && state(hub,"state")=="up" && state(hub,"pending")=="0" &&
        t.texts(32,"take-start")==0 && t.blocks(32)==0 && t.texts(32,"take-ready")==0,
        "recipient-free dispatched take completes without relay or link-protocol");
  }
  {
    Fake t; a::Hub hub({},t,false,false,false); cue.groups(nullptr,0,1);
    Host host; host.attach(); hub.drain_cues();
    hub.sender().add(40); hub.ready(40); hub.opened(40); hub.sender().frame(); t.messages.clear();
    input(hello()); cue.cue(1,id,key.data(),key.size(),"SFX",3,123,1,1); hub.drain_cues();
    a::LinkMessage m; m.type=2; m.key_id=kid; m.stream=400; m.frames=512; input(m); hub.sender().frame();
    const auto closed=hub.sender().take_closes();
    check(closed.size()==1 && closed[0].conn==40 && closed[0].code==1001 && closed[0].reason=="stream-ended" &&
        t.texts(40,"take-start")==0 && t.blocks(40)==0,"changed hello metadata resyncs before new FMOD traffic");
    hub.removed(40); hub.sender().add(41);
    const auto ready=hub.ready(41); hub.opened(41); hub.sender().frame();
    check(ready.find("music")!=std::string::npos && t.texts(41,"audio-state")==1 &&
        t.messages.back().text.find(std::string(32,'1'))!=std::string::npos,"reconnect advertises new lanes and bankset");
    host.attach(); hub.drain_cues(); input(hello()); hub.sender().frame();
    check(hub.sender().take_closes().empty(),"same metadata reattach keeps connection open");
    host.attach(); hub.drain_cues(); auto changed=hello(); changed.lanes[0].name="replacement music";
    input(changed); hub.sender().frame();
    const auto lane_close=hub.sender().take_closes();
    check(lane_close.size()==1 && lane_close[0].conn==41 && lane_close[0].reason=="stream-ended",
        "lane-only metadata change resyncs established client");
    hub.removed(41);
    host.attach(); hub.drain_cues(); input(hello());
    host.attach(); hub.drain_cues();
    hub.sender().add(42); hub.ready(42); hub.sender().text(42,"{\"type\":\"track-ready\"}");
    std::promise<void> started; std::future<int> injected;
    hub.test_before_snapshot=[&] {
      injected=std::async(std::launch::async,[&] { started.set_value(); return input(hello()); });
      started.get_future().wait();
      check(injected.wait_for(std::chrono::milliseconds(20))==std::future_status::timeout,
          "hello cannot pass publication before initial snapshot");
    };
    hub.opened(42); check(injected.get()==1,"barrier hello completes after snapshot"); hub.sender().frame();
    std::vector<std::string> texts; for (const auto &v:t.messages) if (v.conn==42 && !v.text.empty()) texts.push_back(v.text);
    check(texts.size()>=2 && texts[0].find("track-ready")!=std::string::npos && texts[1].find("audio-state")!=std::string::npos,
        "audio-state is first text after ready under concurrent hello");
  }
  check(grc_audio_link_attach_v1(nullptr)==0,"hub shutdown removes endpoint grant");
  {
    Fake t; a::Hub hub({},t);
    struct Callback {
      std::promise<void> entered, release;
      std::thread::id thread;
      static int out(void *self, const std::uint8_t *, std::size_t) {
        auto &c=*static_cast<Callback *>(self); c.thread=std::this_thread::get_id();
        c.entered.set_value(); c.release.get_future().wait(); return 1;
      }
    } c;
    grc_audio_link_v1 api{1,sizeof(api),&c,Callback::out};
    check(grc_audio_link_attach_v1(&api)==1,"attach before any audio connection");
    c.entered.get_future().wait();
    std::promise<void> detaching;
    auto detached=std::async(std::launch::async,[&] { detaching.set_value(); return grc_audio_link_attach_v1(nullptr); });
    detaching.get_future().wait();
    check(detached.wait_for(std::chrono::milliseconds(20))==std::future_status::timeout,"detach waits for in-flight callback");
    c.release.set_value();
    check(detached.get()==1 && c.thread!=std::this_thread::get_id(),"detach returns after callback on rs-audio");
  }
  std::printf("rs_audio_link: %u passed, %u failed\n",checks-failures,failures); return failures?1:0;
}
