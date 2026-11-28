import { normalizePath } from 'utils/common/path';
import { isWindowsOS } from 'utils/common/platform';

const windowsRowKeys = new WeakMap();
const posixRowKeys = new WeakMap();

export const toPathKey = (pathname) => {
  const key = normalizePath(pathname);
  return isWindowsOS() ? key.toLowerCase() : key;
};

export const toRowPathKey = (row) => {
  const rowKeys = isWindowsOS() ? windowsRowKeys : posixRowKeys;
  let key = rowKeys.get(row);
  if (key === undefined) {
    key = toPathKey(row.path);
    rowKeys.set(row, key);
  }
  return key;
};

export const getFolderName = (pathname) => {
  const segments = normalizePath(pathname).split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : pathname;
};
