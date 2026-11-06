export function exactFunctionExecutions(entries, node, parent) {
  const method = (parent?.type === 'Property' && (parent.method || ['get', 'set'].includes(parent.kind)))
    || (parent?.type === 'MethodDefinition' && !parent.static);
  const range = method ? { start: parent.start, end: node.end } : node;
  return entries?.get(`${range.start}:${range.end}`) ?? null;
}

export function mergedFunctionCoverage(executions, start, end, excluded = []) {
  const boundaries = new Set([start, end]);
  for (const ranges of executions) {
    for (const range of ranges) {
      if (range.endOffset <= start || range.startOffset >= end) continue;
      boundaries.add(Math.max(start, range.startOffset));
      boundaries.add(Math.min(end, range.endOffset));
    }
  }
  for (const range of excluded) {
    if (range.end <= start || range.start >= end) continue;
    boundaries.add(Math.max(start, range.start));
    boundaries.add(Math.min(end, range.end));
  }
  const points = [...boundaries].sort((a, b) => a - b);
  let total = 0;
  let covered = 0;
  for (let index = 0; index < points.length - 1; index++) {
    const left = points[index];
    const right = points[index + 1];
    if (excluded.some((range) => range.start <= left && range.end >= right)) continue;
    total += right - left;
    const coveredInAnyExecution = executions.some((ranges) => {
      const containing = ranges.filter((range) => range.startOffset <= left && range.endOffset >= right)
        .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
      return containing[0]?.count > 0;
    });
    if (coveredInAnyExecution) covered += right - left;
  }
  return total ? 100 * covered / total : null;
}

export function mutationGateFailed({ score, threshold, invalid, timeouts, infrastructureErrors }) {
  return score < threshold || invalid > 0 || timeouts > 0 || infrastructureErrors > 0;
}

export function isolatedTestExitCode(testCode, cleanupFailed) {
  if (testCode !== 0) return testCode;
  return cleanupFailed ? 2 : 0;
}
