// Worker entry (owner: character C): builds character geometry off the main thread. Several workers run in parallel
// (humanoidPool in character.js); each keeps its own body cache.
import { buildCharacterData } from './humanoidBuild.js';
import { packedTransferables } from './humanoidAssembly.js';

self.onmessage = (e) => {
  const { id, kind, seed, lod = 0 } = e.data;
  try {
    const data = buildCharacterData(kind, seed, lod);
    self.postMessage({ id, data }, [...packedTransferables(data.packed), data.bindInverses.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack || err) });
  }
};
