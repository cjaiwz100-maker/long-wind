// Extra-bone specification (owner: character C). Pure data, built alongside the geometry (worker-safe).
//
// The rendering skeleton = the 27 contract bones (skeleton.js, in BONE_DEFS order) followed by extras:
//   • rigid extras: frames re-parented at runtime (the weapon frame: hand ↔ scabbard). Identity bind inverse, so
//     their geometry is authored in the extra's own local frame.
//   • chain extras: one bone per cloth-chain node (cloth.js). Bind inverse = inverse(T(node) · R(rest frame)) in the
//     bind space of the chain's parent (character bind space, or the weapon's local frame).
import * as THREE from 'three';
import { BONE_NAMES } from './humanoid.js';
import { chainBindInverses } from './cloth.js';

export class RigSpec {
  constructor() {
    this.nRig = BONE_NAMES.length;
    this.extras = [];    // { name, kind: 'rigid'|'chain', parent?: rig bone name, inverse: number[16] }
    this.chains = [];    // cloth.js chain specs (with bone0)
    this.links = [];
    this.byName = {};
  }

  /** Skeleton index of a rig bone or extra by name. */
  index(name) {
    if (name in this.byName) return this.byName[name];
    const i = BONE_NAMES.indexOf(name);
    if (i < 0) throw new Error(`unknown bone ${name}`);
    return i;
  }

  /** A rigid extra bone (identity inverse) initially attached to rig bone `parent`. */
  rigid(name, parent) {
    const idx = this.nRig + this.extras.length;
    this.extras.push({ name, kind: 'rigid', parent, inverse: new THREE.Matrix4().toArray() });
    this.byName[name] = idx;
    return idx;
  }

  /**
   * A cloth chain. c = { name, parent: bone name, nodes: [[x,y,z]...] (parent bind space), pin?, side, radius?,
   * mask?, drag?, gravity?, stiff?, flutter?, ftl? }. Returns { chain: index, bone0, bones: [skeleton indices] }.
   */
  chain(c) {
    const bone0 = this.nRig + this.extras.length;
    const spec = { ...c, parent: this.index(c.parent), bone0 };
    const inv = chainBindInverses(spec);
    inv.forEach((m, i) => {
      const name = `${c.name}.${i}`;
      this.byName[name] = bone0 + i;
      this.extras.push({ name, kind: 'chain', inverse: m.toArray() });
    });
    this.chains.push(spec);
    return { chain: this.chains.length - 1, bone0, bones: inv.map((_, i) => bone0 + i) };
  }

  link(ca, ia, cb, ib, k = 1) { this.links.push({ a: [ca, ia], b: [cb, ib], k }); }

  get count() { return this.nRig + this.extras.length; }

  toJSON() { return { nRig: this.nRig, extras: this.extras, chains: this.chains, links: this.links, byName: this.byName }; }
}
