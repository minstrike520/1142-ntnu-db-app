/**
 * Shared render counters fed by the <Profiler> wrappers in this directory and
 * by the app-level Profiler in the harness.
 *
 * A "render" here is one Profiler onRender callback: the profiled subtree did
 * actual render work in a commit (React skips the callback entirely when the
 * whole subtree bailed out). `actualDuration` is the dev-build render time of
 * that subtree for that commit, in milliseconds.
 */
export interface RenderStats {
  renders: number;
  actualDuration: number;
}

const stats = new Map<string, RenderStats>();

export const recordRender = (group: string, actualDuration: number): void => {
  const entry = stats.get(group);
  if (entry) {
    entry.renders += 1;
    entry.actualDuration += actualDuration;
  } else {
    stats.set(group, { renders: 1, actualDuration });
  }
};

export const resetRenderStats = (): void => {
  stats.clear();
};

export const getRenderStats = (group: string): RenderStats => {
  const entry = stats.get(group);
  return entry ? { ...entry } : { renders: 0, actualDuration: 0 };
};
