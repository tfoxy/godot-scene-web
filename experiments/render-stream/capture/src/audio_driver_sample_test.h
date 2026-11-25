#pragma once
namespace grc::audio {
// Explicit test-only injection; production supplies variants from its asset worker.
void sample_test_begin();
void sample_test_end();
}
