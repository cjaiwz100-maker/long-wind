// Matrix storage fix (perf). Owner: core. Imported first by app.js, before any scene object exists.
//
// three keeps Matrix4/Matrix3 elements in plain JS arrays. V8's keyed-store ICs generalise the elements kind of the
// arrays they store into: once a few matrix arrays had turned into generic (PACKED_ELEMENTS) arrays — it happened
// while the Tripo GLBs were parsed — the shared multiplyMatrices / compose / copy stores converted every other matrix
// array to generic too, and from then on each stored product allocated a HeapNumber: ~80 MB/s of garbage from
// matrix math alone (≈5000 products a frame for seven skinned characters), and GC pauses in fights.
// Float64Array storage has a fixed elements kind (same precision as a double array): stores never box.
// An accessor on the prototype catches three's own `this.elements = [...]` in the constructors.
import * as THREE from 'three';

function typed(Cls) {
  const P = Cls.prototype;
  if (Object.getOwnPropertyDescriptor(P, 'elements')) return;
  Object.defineProperty(P, 'elements', {
    configurable: true,
    get() { return this._el; },
    set(v) { this._el = v instanceof Float64Array ? v : Float64Array.from(v); },
  });
}
if (typeof location === 'undefined' || !new URLSearchParams(location.search).has('nomxfix')) { typed(THREE.Matrix4); typed(THREE.Matrix3); }
