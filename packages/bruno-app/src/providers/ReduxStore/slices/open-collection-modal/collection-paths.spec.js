import * as platformUtils from 'utils/common/platform';
import { toRowPathKey } from './collection-paths';

jest.mock('utils/common/platform', () => ({
  ...jest.requireActual('utils/common/platform'),
  isWindowsOS: jest.fn()
}));

describe('toRowPathKey', () => {
  beforeEach(() => {
    platformUtils.isWindowsOS.mockReturnValue(false);
  });

  it('keys a row by its normalised path, lowercased on Windows', () => {
    expect(toRowPathKey({ path: '/work/api/' })).toBe('/work/api');

    platformUtils.isWindowsOS.mockReturnValue(true);

    expect(toRowPathKey({ path: 'C:\\Work\\API\\' })).toBe('c:/work/api');
  });

  it('reads the path of a row only once', () => {
    let pathReads = 0;
    const row = {
      get path() {
        pathReads += 1;
        return '/work/api';
      }
    };

    expect([toRowPathKey(row), toRowPathKey(row)]).toEqual(['/work/api', '/work/api']);
    expect(pathReads).toBe(1);
  });

  it('gives a row the key of the platform it is asked on', () => {
    const row = { path: 'C:\\Work\\API' };

    expect(toRowPathKey(row)).toBe('C:/Work/API');

    platformUtils.isWindowsOS.mockReturnValue(true);

    expect(toRowPathKey(row)).toBe('c:/work/api');

    platformUtils.isWindowsOS.mockReturnValue(false);

    expect(toRowPathKey(row)).toBe('C:/Work/API');
  });
});
