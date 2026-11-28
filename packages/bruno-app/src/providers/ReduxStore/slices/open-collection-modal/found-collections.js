import { toRowPathKey } from './collection-paths';

export const mergeFoundCollections = (rows, incoming) => {
  const merged = [...rows];
  const indexByKey = new Map(merged.map((row, index) => [toRowPathKey(row), index]));
  for (const row of incoming) {
    const key = toRowPathKey(row);
    if (indexByKey.has(key)) {
      merged[indexByKey.get(key)] = row;
    } else {
      indexByKey.set(key, merged.length);
      merged.push(row);
    }
  }
  return merged;
};
