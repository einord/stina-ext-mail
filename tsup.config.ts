import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Bundle everything into a single file for the extension
  // The runtime should be bundled so the extension is self-contained
  noExternal: [/.*/],
  // Only the type exports are external (not needed at runtime)
  external: ['@stina/extension-api'],
})
