const DEFAULT_STRING_SAMPLE_CHARS = 1_024;
const DEFAULT_NODE_BUDGET = 20_000;
const DEFAULT_ESTIMATED_CHAR_BUDGET = 500_000;

function valueKind(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function memoryUsageSnapshot(memoryUsage = process.memoryUsage) {
  try {
    const usage = memoryUsage();
    return {
      heapUsed: Number(usage?.heapUsed || 0),
      heapTotal: Number(usage?.heapTotal || 0),
      rss: Number(usage?.rss || 0),
      external: Number(usage?.external || 0),
    };
  } catch {
    return null;
  }
}

// This deliberately does not JSON.stringify the input. It is bounded traversal
// telemetry for diagnosing retained/duplicated graphs without creating another
// giant allocation while an OOM is being investigated.
export function inspectRuntimeObject(value, {
  nodeBudget = DEFAULT_NODE_BUDGET,
  estimatedCharBudget = DEFAULT_ESTIMATED_CHAR_BUDGET,
  stringSampleChars = DEFAULT_STRING_SAMPLE_CHARS,
} = {}) {
  const stats = {
    rootKind: valueKind(value),
    uniqueObjects: 0,
    repeatedReferences: 0,
    arrays: 0,
    objects: 0,
    keys: 0,
    strings: 0,
    stringChars: 0,
    numbers: 0,
    booleans: 0,
    nulls: 0,
    otherScalars: 0,
    maxDepth: 0,
    estimatedSerializedChars: 0,
    estimatedCharsCapped: false,
    traversalCapped: false,
  };
  const seen = new WeakSet();
  const stack = [{ value, depth: 0 }];

  function addEstimated(chars) {
    if (stats.estimatedCharsCapped) return;
    stats.estimatedSerializedChars += Math.max(0, Number(chars) || 0);
    if (stats.estimatedSerializedChars >= estimatedCharBudget) {
      stats.estimatedSerializedChars = estimatedCharBudget;
      stats.estimatedCharsCapped = true;
    }
  }

  while (stack.length) {
    const current = stack.pop();
    stats.maxDepth = Math.max(stats.maxDepth, current.depth);
    const kind = valueKind(current.value);
    if (kind === 'null') {
      stats.nulls += 1;
      addEstimated(4);
      continue;
    }
    if (kind === 'string') {
      stats.strings += 1;
      const chars = current.value.length;
      stats.stringChars += chars;
      addEstimated(Math.min(chars, stringSampleChars) + 2);
      if (chars > stringSampleChars) stats.estimatedCharsCapped = true;
      continue;
    }
    if (kind === 'number') {
      stats.numbers += 1;
      addEstimated(24);
      continue;
    }
    if (kind === 'boolean') {
      stats.booleans += 1;
      addEstimated(5);
      continue;
    }
    if (kind !== 'object' && kind !== 'array') {
      stats.otherScalars += 1;
      addEstimated(32);
      continue;
    }
    if (seen.has(current.value)) {
      stats.repeatedReferences += 1;
      addEstimated(8);
      continue;
    }
    seen.add(current.value);
    stats.uniqueObjects += 1;
    if (stats.uniqueObjects > nodeBudget) {
      stats.traversalCapped = true;
      break;
    }
    if (kind === 'array') {
      stats.arrays += 1;
      addEstimated(2);
      // Do not enqueue an unbounded array before the node budget can stop us.
      const remainingNodes = Math.max(0, nodeBudget - stats.uniqueObjects);
      const items = Math.min(current.value.length, remainingNodes);
      for (let index = items - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      if (current.value.length > items) stats.traversalCapped = true;
      continue;
    }
    stats.objects += 1;
    addEstimated(2);
    // Object.entries() materializes every key/value pair before our node
    // budget can stop traversal. It is exactly the wrong primitive while
    // diagnosing a malformed provider envelope with millions of properties.
    // Enumerate incrementally and stop at the remaining node budget instead.
    let keysSeen = 0;
    for (const key in current.value) {
      if (!Object.hasOwn(current.value, key)) continue;
      keysSeen += 1;
      stats.keys += 1;
      addEstimated(key.length + 3);
      stack.push({ value: current.value[key], depth: current.depth + 1 });
      if (keysSeen >= Math.max(0, nodeBudget - stats.uniqueObjects)) {
        stats.traversalCapped = true;
        break;
      }
    }
  }
  return stats;
}

export function runtimeHeapStage(stage, objects = {}, { memoryUsage = process.memoryUsage, inspect = false } = {}) {
  // Heap telemetry cannot walk a live provider/tool graph in production. A
  // bounded walker can still retain millions of array children on its own stack
  // before the budget is reached. Keep production stages scalar-only; explicit
  // test/offline callers may opt into graph inspection.
  const summaries = {};
  for (const [name, value] of Object.entries(objects || {})) {
    summaries[name] = inspect
      ? inspectRuntimeObject(value)
      : { rootKind: valueKind(value), inspection: 'disabled' };
  }
  return {
    stage: String(stage || 'unknown'),
    memory: memoryUsageSnapshot(memoryUsage),
    objects: summaries,
  };
}
