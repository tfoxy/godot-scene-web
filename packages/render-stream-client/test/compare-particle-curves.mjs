// Compare a legacy particles_sync JSON with sidecar metadata and its little-endian f32 arena.
// Usage: node packages/render-stream-client/test/compare-particle-curves.mjs BEFORE.json AFTER.json CURVES.f32
// The inputs must describe the same accepted state with fresh particle-description caches.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [beforePath, afterPath, curvesPath] = process.argv.slice(2);
assert(
  beforePath && afterPath && curvesPath,
  "Pass BEFORE.json AFTER.json CURVES.f32",
);
const beforeBytes = readFileSync(beforePath);
const afterBytes = readFileSync(afterPath);
const arena = readFileSync(curvesPath);
const before = JSON.parse(beforeBytes.toString());
const after = JSON.parse(afterBytes.toString());
let curves = 0;
let floats = 0;
for (let i = 0; i < before.materials.length; i++) {
  const oldMaterial = before.materials[i];
  const material = after.materials[i];
  assert.equal(material.id, oldMaterial.id);
  assert.deepEqual(
    Object.keys(material.curves),
    Object.keys(oldMaterial.curves),
  );
  for (const [name, oldCurve] of Object.entries(oldMaterial.curves)) {
    const curve = material.curves[name];
    assert.equal(curve.width, oldCurve.width);
    assert.equal(curve.height, oldCurve.height);
    assert.equal(curve.length, oldCurve.data.length);
    assert.equal(
      curve.offset,
      floats,
      "The arena must contain exactly the emitted curves",
    );
    const expected = Buffer.alloc(curve.length * 4);
    for (let j = 0; j < oldCurve.data.length; j++)
      expected.writeFloatLE(oldCurve.data[j], j * 4);
    assert.deepEqual(
      arena.subarray(curve.offset * 4, (curve.offset + curve.length) * 4),
      expected,
      `Material ${material.id} curve ${name}: f32 input bytes changed`,
    );
    // Check all remaining metadata, including f64 uniforms and emitter counters, independently.
    oldMaterial.curves[name] = {
      width: oldCurve.width,
      height: oldCurve.height,
    };
    material.curves[name] = { width: curve.width, height: curve.height };
    curves++;
    floats += curve.length;
  }
}
assert(curves > 0, "The replay must exercise curve transport");
assert.equal(arena.length, floats * 4);
assert.deepEqual(after, before);
console.log(
  JSON.stringify({
    emitters: after.emitters.length,
    materials: after.materials.length,
    curves,
    floats,
    before_json_bytes: beforeBytes.length,
    after_json_bytes: afterBytes.length,
    sidecar_bytes: arena.length,
    metadata_equal: true,
    curve_bytes_equal: true,
  }),
);
