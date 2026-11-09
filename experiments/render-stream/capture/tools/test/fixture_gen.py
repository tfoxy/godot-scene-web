"""Generate compiler fixtures whose final class forces a direct wanted call."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import synth


def generate(directory, victim):
    directory = Path(directory)
    declarations = synth.declarations()
    header = ['#pragma once', '#if defined(__GNUC__) && !defined(__clang__)',
              '#define FIXTURE_NOINLINE __attribute__((noinline, no_icf))', '#else',
              '#define FIXTURE_NOINLINE __attribute__((noinline))', '#endif', 'struct Object {', '  virtual void object_a();',
              '  virtual void object_b();', '  virtual void object_c();',
              '  virtual ~Object();', '};', 'class RenderingServer : public Object {', 'public:',
              '  __attribute__((noinline)) RenderingServer();']
    for name, pure in declarations:
        header.append(f'  virtual void {name}(unsigned long x) = 0;' if pure else
                      f'  virtual bool {name}() const {{ return false; }}')
    # A pure destructor keeps abstract destructor and method placeholders uniform in PIE.
    header.extend(['  virtual ~RenderingServer() = 0;', '};',
                   'class RenderingServerDefault final : public RenderingServer {', 'public:',
                   '  ~RenderingServerDefault() override;'])
    for name, pure in declarations:
        if pure:
            header.append(f'  FIXTURE_NOINLINE void {name}(unsigned long x) override;')
    header.extend(['};', ''])
    (directory / 'fixture.h').write_text('\n'.join(header))
    source = ['#include "fixture.h"', 'volatile unsigned long g_sink = 0;',
              'void Object::object_a() {}', 'void Object::object_b() {}', 'void Object::object_c() {}',
              'Object::~Object() {}', 'RenderingServer::RenderingServer() {}', 'RenderingServer::~RenderingServer() {}',
              'RenderingServerDefault::~RenderingServerDefault() {}']
    for name, pure in declarations:
        if pure:
            source.append(f'void RenderingServerDefault::{name}(unsigned long x) {{ g_sink += x; }}')
    source.extend(['extern "C" __attribute__((used)) const char kVer[] = "Godot Engine v4.5.1.stable.census-fixture";',
                   f'__attribute__((noinline)) void fixture_direct(RenderingServerDefault *rs) {{ rs->{victim}(1); }}',
                   '__attribute__((noinline)) void fixture_indirect(RenderingServer *rs) { rs->canvas_item_add_rect(1); }',
                   'int main() { RenderingServerDefault rs; fixture_direct(&rs); fixture_indirect(&rs); }', ''])
    (directory / 'fixture.cpp').write_text('\n'.join(source))
    return directory / 'fixture.h', directory / 'fixture.cpp'
