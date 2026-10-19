import { defineConfig } from 'vite';

export default defineConfig({
  // three-mesh-bvh declares three as a peer; without dedupe the dev server
  // pre-bundles a second copy and every `instanceof` check gets dicey.
  resolve: { dedupe: ['three'] },
  optimizeDeps: { include: ['three', 'three-mesh-bvh'] },
});
