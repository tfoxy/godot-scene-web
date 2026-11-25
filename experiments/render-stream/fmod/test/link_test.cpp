#include "link.hpp"
#include "lane.hpp"
#include "clock.hpp"
#include <iostream>
#include <stdexcept>
using namespace grc::fmod;
using grc::audio::LinkMessage;
void require(bool value, const char *why) { if (!value) throw std::runtime_error(why); }
int main() {
 try {
  require(uuid_domain("00112233-4455-6677-8899-AaBbCcDdEeFf") == "00112233445566778899aabbccddeeff", "UUID byte order");
  require(uuid_domain("invalid") == std::string(32, '0'), "failed clock read must fail closed");
  unsigned invalid = 0;
  auto lanes = parse_lanes("1:music:bus:/master/music,2:ambience:bus:/master/ambience:amb,3:x:bus:/master/sfx:bad\\group,0:no:bus:/no", [&](const std::string &reason) { require(reason == "lane-config", "config reason"); ++invalid; });
  require(lanes.size() == 2 && invalid == 2 && lanes[0].wire.group == "music" && lanes[1].wire.group == "amb", "lane bus/group mapping");
  std::vector<std::pair<std::uint32_t, LinkMessage>> out;
  struct Requested { std::uint32_t seat; std::uint64_t generation; LinkMessage want; };
  std::vector<Requested> requests;
  std::vector<std::string> logs;
  const std::string domain(32, 'a'), bankset(32, 'b');
  Link link(domain, bankset, {lanes[0].wire,lanes[1].wire}, [&](auto seat, const Bytes &b) {out.emplace_back(seat,grc::audio::decode_link(b));},
    [&](auto seat, auto generation, const LinkMessage &want) { requests.push_back({seat,generation,want}); }, [&](auto seat, const std::string &why) {logs.push_back(std::to_string(seat)+":"+why);});
  LinkMessage want; want.type = 5; want.key = "event:/sfx/ui/test"; want.key_id = grc::audio::key_id(want.key); want.t_us = 100000;
  auto send = [&](unsigned seat, const LinkMessage &m) {link.input(seat,grc::audio::encode_link(m));};
  auto hello = [&] { LinkMessage m; m.clock_domain = domain; m.bankset = std::string(32,'0'); return m; };
  link.open(1); require(out.back().second.bankset == bankset && out.back().second.lanes.size() == 2, "host hello");
  send(1,want); require(out.back().second.type == 4 && out.back().second.reason == 4, "pre-hello want queued");
  send(1,hello()); send(1,want); require(requests.size()==1,"want not requested");
  std::vector<float> samples(3000*2,.1f);
  auto take = std::make_shared<Take>(validate_take(samples,{1,1,0,0},false));
  link.take(1,requests[0].generation,want,take);
  const auto n=out.size(); require(out[n-4].second.type==2 && out[n-1].second.type==3,"take lifecycle");
  auto a=grc::audio::decode_block(out[n-3].second.block), b=grc::audio::decode_block(out[n-2].second.block);
  require(a.header.flags==1 && a.header.frames==2048 && b.header.flags==2 && b.header.frames==952 && a.header.stream==b.header.stream && a.header.sent_us==0,"take headers");
  require(b.header.due_us==want.t_us+2048ULL*1000000/48000,"take due time");
  Bytes received=a.payload; received.insert(received.end(),b.payload.begin(),b.payload.end()); require(received==take->pcm,"take PCM changed");
  link.close(1); link.open(1); send(1,hello());
  auto before=out.size(); link.take(1,requests[0].generation,want,take); require(out.size()==before,"closed seat got pending take");
  send(1,want); link.take(1,requests.back().generation,want,take); require(out.back().second.stream != a.header.stream,"take stream reused");
  LinkMessage mask; mask.type=6; mask.lane_mask=2; send(1,mask); require(link.mask()==2,"subscription");
  link.open(2); send(2,hello()); mask.lane_mask=4; send(2,mask); require(link.mask()==6,"union mask");
  grc::audio::BlockHeader header; header.kind=2; header.lane=1; header.frames=512; header.flags=4;
  before=out.size(); link.lane(header,{}); require(out.size()==before+1 && out.back().first==1,"lane leaked to unsubscribed seat");
  link.close(1); require(link.mask()==4,"close retained subscription");
  auto wrong=hello(); wrong.clock_domain=std::string(32,'c'); link.open(3); send(3,wrong); send(3,want);
  require(out.back().second.type==4 && out.back().second.reason==4,"domain mismatch accepted");
  require(logs.size()==1 && logs[0]=="3:clock-domain", "per-seat clock-domain evidence");
  send(3,wrong); require(logs.size()==1,"seat failure logged twice");
  link.open(4); auto version=grc::audio::encode_link(hello()); version[1]=2; link.input(4,version); send(4,want);
  require(out.back().second.reason==4 && logs.size()==2,"wrong link version accepted");
  link.open(5); auto zero=hello();zero.clock_domain=std::string(32,'0');send(5,zero);send(5,want);
  require(out.back().second.reason==4,"zero clock domain accepted");
  // A malformed want must fail only its seat before reaching a render worker.
  for (const auto *suffix : {"|p=1.0", "|p"}) {
    link.open(1); send(1,hello());
    auto bad=want; bad.key+=suffix; bad.key_id=grc::audio::key_id(bad.key);
    const auto requested=requests.size(); send(1,bad);
    require(requests.size()==requested,"noncanonical key reached renderer");
    require(out.back().first==1 && out.back().second.type==4 && out.back().second.key_id==bad.key_id && out.back().second.reason==4,"malformed want unavailable");
    send(1,want); require(requests.size()==requested && out.back().second.reason==4,"malformed seat stayed up");
    require(link.mask()==4,"malformed seat disabled peer lane");
    send(2,want); link.take(2,requests.back().generation,want,take);
    require(out.back().first==2 && out.back().second.type==3,"malformed seat disabled peer take");
    header.lane=2; before=out.size();link.lane(header,{});
    require(out.size()==before+1 && out.back().first==2,"malformed seat disabled peer PCM");
  }
  send(2,want); const auto pending=requests.back();
  before=out.size();link.disable(); require(link.mask()==0,"disabled media clock");
  require(out.size()==before+1 && out.back().second.type==4 && out.back().second.reason==3,"pending want lost on disable");
  before=out.size();link.take(pending.seat,pending.generation,pending.want,take);
  require(out.size()==before,"failed pending want completed twice");
  send(2,want);require(out.back().second.reason==3,"disabled endpoint stopped responding");
  link.open(6);send(6,hello());send(6,want);require(out.back().second.reason==3,"late seat hangs after disable");
  LaneState state; state.apply({3,55,"event:/music/test",0}); state.apply({7,55,"Progress",.5f}); state.apply({4,55,"",0}); state.apply({9,55,"",1}); state.apply({8,0,"Global",1});
  require(state.events().at(55).playing && state.events().at(55).paused && state.events().at(55).parameters.at("Progress")==.5f && state.globals().at("Global")==1,"dormant snapshot");
  LaneState banks({"res://known.bank"});
  banks.apply({1,0,"res://known.bank",0});banks.apply({2,0,"res://known.bank",0});
  banks.apply({1,0,"res://unknown.bank",0});banks.apply({2,0,"res://unknown.bank",0});
  banks.apply({1,0,"res://known.bank",0});
  require(banks.bank_loads==3 && banks.bank_unloads==2 && banks.bank_unknown==2,"bank evidence changed fixed membership");
  state.apply({5,55,"",1}); require(!state.events().at(55).playing,"stop snapshot"); state.apply({6,55,"",0}); require(state.events().empty(),"release snapshot");
  std::cout<<"PASS clock bytes, lane config, hello, mismatch, takes, pending close, epochs, subscriptions, snapshots\n";
 } catch(const std::exception &e) {std::cerr<<"FAIL "<<e.what()<<'\n';return 1;}
}
