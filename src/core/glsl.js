// GLSL helpers. Owner: integrator.
// Every shared uniform declaration MUST be guarded so several chunks (prelude, atmosphere, wind, your own) can be
// concatenated into one shader without "redefinition" errors. Guard macro name = WXU_<uniformName>.
//   U('float', 'uTime')  ->  #ifndef WXU_uTime / #define WXU_uTime / uniform float uTime; / #endif
export function U(type, name, arr = '') {
  return `#ifndef WXU_${name}\n#define WXU_${name}\nuniform ${type} ${name}${arr};\n#endif\n`;
}
