const { createFolderQueue } = require('./folder-queue');

const takeFolders = (queue, count) => Array.from({ length: count }, () => queue.take());

describe('createFolderQueue', () => {
  it('takes folders from the roots in turn, newest first within each root', () => {
    const queue = createFolderQueue();
    const queueAlpha = queue.addRoot();
    const queueBeta = queue.addRoot();
    ['alpha-1', 'alpha-2', 'alpha-3'].forEach((folder) => queueAlpha(folder));
    ['beta-1', 'beta-2'].forEach((folder) => queueBeta(folder));

    expect(takeFolders(queue, 5)).toEqual(['alpha-3', 'beta-2', 'alpha-2', 'beta-1', 'alpha-1']);
    expect(queue.isEmpty()).toBe(true);
  });

  it('skips a root with nothing queued, and gives a root its turn again once it queues more', () => {
    const queue = createFolderQueue();
    const queueAlpha = queue.addRoot();
    const queueBeta = queue.addRoot();
    const queueGamma = queue.addRoot();
    queueAlpha('alpha-1');
    ['gamma-1', 'gamma-2'].forEach((folder) => queueGamma(folder));

    expect(takeFolders(queue, 2)).toEqual(['alpha-1', 'gamma-2']);
    queueBeta('beta-1');
    expect(takeFolders(queue, 2)).toEqual(['beta-1', 'gamma-1']);
    expect(queue.isEmpty()).toBe(true);
  });

  it('gives a root added after taking has begun its turn', () => {
    const queue = createFolderQueue();
    const queueAlpha = queue.addRoot();
    ['alpha-1', 'alpha-2', 'alpha-3'].forEach((folder) => queueAlpha(folder));

    expect(queue.take()).toBe('alpha-3');
    queue.addRoot()('beta-1');
    expect(takeFolders(queue, 3)).toEqual(['alpha-2', 'beta-1', 'alpha-1']);
    expect(queue.isEmpty()).toBe(true);
  });

  it('is empty until a folder is queued and again once every folder is taken', () => {
    const queue = createFolderQueue();
    expect(queue.isEmpty()).toBe(true);

    const queueAlpha = queue.addRoot();
    expect(queue.isEmpty()).toBe(true);

    queueAlpha('alpha-1');
    expect(queue.isEmpty()).toBe(false);
    expect(queue.take()).toBe('alpha-1');
    expect(queue.isEmpty()).toBe(true);
    expect(queue.take()).toBeUndefined();
  });
});
