#ifndef GRC_RS_DETACH_RELEASE_H
#define GRC_RS_DETACH_RELEASE_H

namespace grc::rs::capture {
// Keep the allocator release outside arm cleanup: a prior disarm can have recorded its
// release already, and attachment-only objects must be freed before returning pages.
template <typename Cleanup, typename Release>
bool detach_release(Cleanup cleanup, Release release) {
  if (!cleanup()) return false;
  release();
  return true;
}
}  // namespace grc::rs::capture
#endif
