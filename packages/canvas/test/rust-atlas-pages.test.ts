import { describe, expect, it } from "vitest";
import { RustAtlasPages } from "../src/rust-atlas-pages";

describe("Rust atlas page residency", () => {
  it("caps four allocated pages and protects active plus in-flight references", () => {
    const pageBytes = 1024 * 1024 * 4;
    const pages = new RustAtlasPages(pageBytes * 4);
    for (const key of ["a:g1", "b:g1", "c:g1", "d:g1"]) {
      const plan = pages.reserve(key, 1024, 1024);
      expect(plan.evicted).toEqual([]);
      pages.commit(plan);
    }
    pages.pin(["a:g1", "b:g1", "c:g1", "d:g1"]);
    expect(() => pages.reserve("e:g1", 1024, 1024)).toThrow("pinned");
    expect(pages.stats()).toEqual({
      pages: 4,
      bytes: pageBytes * 4,
      pinned: 4,
      pending: 0,
    });
    pages.pin(["a:g1", "b:g1", "c:g1"]);
    const fifth = pages.reserve("e:g1", 1024, 1024);
    expect(fifth.evicted).toEqual(["d:g1"]);
    pages.cancel(fifth);
    expect(pages.stats()).toEqual({
      pages: 4,
      bytes: pageBytes * 4,
      pinned: 3,
      pending: 0,
    });
  });
  it("commits least-recent unpinned eviction only after upload", () => {
    const pages = new RustAtlasPages(32);
    pages.commit(pages.reserve("a", 2, 2));
    pages.commit(pages.reserve("b", 2, 2));
    pages.pin(["a"]);
    const plan = pages.reserve("c", 2, 2);
    expect(plan.evicted).toEqual(["b"]);
    expect(pages.stats()).toEqual({
      pages: 2,
      bytes: 32,
      pinned: 1,
      pending: 1,
    });
    pages.commit(plan);
    expect(pages.stats()).toEqual({
      pages: 2,
      bytes: 32,
      pinned: 1,
      pending: 0,
    });
    expect(() => pages.reserve("large", 3, 2)).toThrow("pinned");
    pages.pin([]);
    const large = pages.reserve("large", 3, 2);
    expect(large.evicted).toEqual(["a", "c"]);
    pages.commit(large);
    expect(pages.stats()).toEqual({
      pages: 1,
      bytes: 24,
      pinned: 0,
      pending: 0,
    });
  });

  it("leaves residency and LRU untouched after a failed upload is cancelled", () => {
    const pages = new RustAtlasPages(32);
    pages.commit(pages.reserve("a", 2, 2));
    pages.commit(pages.reserve("b", 2, 2));
    pages.touch("a"); // b is the LRU victim.
    const before = pages.stats();
    const failed = pages.reserve("c", 2, 2);
    expect(failed.evicted).toEqual(["b"]);
    pages.cancel(failed);
    expect(pages.stats()).toEqual(before);
    expect(pages.reserve("c", 2, 2).evicted).toEqual(["b"]);
  });

  it("rejects a pinned page resize while allowing a same-size reservation", () => {
    const pages = new RustAtlasPages(64);
    pages.commit(pages.reserve("a", 2, 2));
    pages.pin(["a"]);
    expect(() => pages.reserve("a", 3, 2)).toThrow("cannot resize pinned");
    const same = pages.reserve("a", 2, 2);
    expect(same.evicted).toEqual([]);
    pages.cancel(same);
    expect(pages.stats()).toEqual({
      pages: 1,
      bytes: 16,
      pinned: 1,
      pending: 0,
    });
    pages.commit(pages.reserve("a", 2, 2));
    expect(pages.stats()).toEqual({
      pages: 1,
      bytes: 16,
      pinned: 1,
      pending: 0,
    });
  });

  it("rejects a pinned reshape even when the byte count is unchanged", () => {
    const pages = new RustAtlasPages(64);
    pages.commit(pages.reserve("a", 2, 3));
    pages.pin(["a"]);
    expect(() => pages.reserve("a", 3, 2)).toThrow("cannot resize pinned");
    expect(pages.stats()).toEqual({
      pages: 1,
      bytes: 24,
      pinned: 1,
      pending: 0,
    });
    pages.commit(pages.reserve("a", 2, 3));
    expect(pages.stats()).toEqual({
      pages: 1,
      bytes: 24,
      pinned: 1,
      pending: 0,
    });
  });

  it("protects pending pages and invalidates dependent plans on cancellation", () => {
    const pages = new RustAtlasPages(32);
    pages.commit(pages.reserve("a", 2, 2));
    const first = pages.reserve("b", 2, 2);
    expect(() => pages.reserve("b", 2, 2)).toThrow("pending");
    expect(() => pages.touch("a")).toThrow("finish atlas reservations");
    const second = pages.reserve("c", 2, 2);
    expect(second.evicted).toEqual(["a"]);
    expect(() => pages.reserve("d", 2, 2)).toThrow("reserved");
    expect(() => pages.commit(second)).toThrow("order");
    pages.cancel(first);
    expect(() => pages.commit(second)).toThrow("order");
    expect(pages.stats()).toEqual({
      pages: 1,
      bytes: 16,
      pinned: 0,
      pending: 0,
    });
    const next = pages.reserve("c", 2, 2);
    expect(next.evicted).toEqual([]);
    pages.commit(next);
    expect(pages.stats()).toEqual({
      pages: 2,
      bytes: 32,
      pinned: 0,
      pending: 0,
    });
  });
});
