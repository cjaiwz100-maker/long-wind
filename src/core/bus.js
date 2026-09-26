// Tiny global event bus. Gameplay EMITS, HUD / audio / VFX / camera SUBSCRIBE. Owner: integrator.
// Event names + payloads are a CONTRACT — see CONTRACTS.md §Events.
const handlers = new Map();
export const bus = {
  on(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); return () => handlers.get(type)?.delete(fn); },
  off(type, fn) { handlers.get(type)?.delete(fn); },
  emit(type, payload = {}) {
    const hs = handlers.get(type);
    if (hs) for (const fn of [...hs]) { try { fn(payload, type); } catch (e) { console.error(`bus handler for ${type} failed`, e); } }
    const any = handlers.get('*');
    if (any) for (const fn of [...any]) { try { fn(payload, type); } catch (e) { console.error(e); } }
  },
};
