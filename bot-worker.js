// Worker perhitungan bot agar animasi tidak tersendat.
importScripts('engine.js');
self.onmessage = e => {
  const { id, state, level, seed } = e.data;
  self.postMessage({ id, shot: PoolEngine.botPlan(state, level, seed) });
};
