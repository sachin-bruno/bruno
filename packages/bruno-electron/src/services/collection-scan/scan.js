const fs = require('node:fs/promises');
const path = require('node:path');
const { getRealPath, toPathKey, isSameOrInside, isPrunedFolderName, hasCollectionConfig } = require('../collection-search/walk');
const { isRealFolder } = require('../collection-search/entry-kind');
const { readMountTable, skippedMountPointsOf } = require('../collection-search/mount-points');
const { findCloudFolders, isDatalessFile, findCloudOnlyFiles } = require('./cloud-folders');
const { readCollectionName } = require('./collection-name');
const { createFolderQueue } = require('./folder-queue');
const { planWholeComputer } = require('./whole-computer');

const MAX_FOLDER_DEPTH = 32;
const CONCURRENCY = 16;
const RECENTS_CONCURRENCY = 4;
const CLOUD_CHECK_BATCH_SIZE = 25;
const RECENTS_LOCATION_ID = 'recents';
const WHOLE_COMPUTER_KINDS = new Set(['home', 'computer']);
const PACKAGE_FOLDER_NAMES = new Set(['site-packages', 'steamapps']);
const HOME_PACKAGE_FOLDERS = [
  ['go', 'pkg', 'mod'],
  ['anaconda3', 'pkgs'],
  ['miniconda3', 'pkgs'],
  ['miniforge3', 'pkgs'],
  ['scoop', 'apps'],
  ['scoop', 'cache']
];

const DRIVE_ROOT = /^[A-Za-z]:\\$/;

const isUncPath = (folderPath, platform) => platform === 'win32' && folderPath.startsWith('\\\\');

const toRootStatus = (error) => (error.code === 'EACCES' || error.code === 'EPERM' ? 'denied' : 'missing');

const readMtime = (folderPath) => fs.stat(folderPath).then((stats) => Math.floor(stats.mtimeMs), () => 0);

const toResolvedPathKey = (folderPath) => toPathKey(path.resolve(folderPath));

const toRealPathKeyWithoutOpening = async (folderPath) => {
  const resolvedPath = path.resolve(folderPath);
  if ((await fs.lstat(resolvedPath).catch(() => null))?.isSymbolicLink()) {
    return toPathKey(await getRealPath(resolvedPath).catch(() => resolvedPath));
  }
  const parentPath = path.dirname(resolvedPath);
  return toPathKey(path.join(await getRealPath(parentPath).catch(() => parentPath), path.basename(resolvedPath)));
};

const toFolderDepth = (realPath) => path.relative(path.parse(realPath).root, realPath).split(path.sep).filter(Boolean).length;

const withTrailingSeparator = (folderPath) => (folderPath.endsWith(path.sep) ? folderPath : `${folderPath}${path.sep}`);

const isComputerLocation = (location) => location.kind === 'computer';

const isWholeComputerLocation = (location) => WHOLE_COMPUTER_KINDS.has(location.kind);

const isPackageFolderName = (name, platform) => PACKAGE_FOLDER_NAMES.has(platform === 'win32' ? name.toLowerCase() : name);

const isCollectionManifest = (entry) => hasCollectionConfig([entry]);

const toDriveRootMounts = (locations) =>
  [...new Set(locations.map((location) => path.win32.parse(location.path).root))]
    .filter((root) => DRIVE_ROOT.test(root))
    .map((root) => ({ path: root, kind: 'local' }));

const innermostLocationOf = (locations, folderPath) => {
  const folderKey = toResolvedPathKey(folderPath);
  return locations
    .map((location) => ({ location, key: toResolvedPathKey(location.path) }))
    .filter(({ key }) => isSameOrInside(key, folderKey))
    .sort((a, b) => b.key.length - a.key.length)[0]?.location;
};

const toRoots = ({ locations, planRoots }) => {
  const otherLocations = locations.filter((location) => !isComputerLocation(location));
  const locationRoots = otherLocations.map(({ id, path: rootPath }) => ({ locationId: id, path: rootPath, reportsStatus: true }));
  const locationKeys = new Set(otherLocations.map((location) => toResolvedPathKey(location.path)));
  const extraRoots = planRoots.filter((rootPath) => !locationKeys.has(toResolvedPathKey(rootPath)));
  const computer = locations.find(isComputerLocation);
  if (!computer) {
    return [
      ...locationRoots,
      ...extraRoots.flatMap((rootPath) => {
        const owner = innermostLocationOf(otherLocations, rootPath);
        return owner ? [{ locationId: owner.id, path: rootPath, reportsStatus: false }] : [];
      })
    ];
  }
  const systemRootKey = toResolvedPathKey(computer.path);
  return [
    ...locationRoots,
    ...extraRoots.map((rootPath) => ({ locationId: computer.id, path: rootPath, reportsStatus: toResolvedPathKey(rootPath) === systemRootKey }))
  ];
};

const scanLocations = async ({
  locations,
  recents,
  excludedPaths,
  onCollection,
  platform = process.platform,
  env = process.env,
  homePath,
  knownFolders = []
}) => {
  const searchesComputer = locations.some(isComputerLocation);
  // On Windows the mount table only feeds the whole computer plan, and reading it starts PowerShell.
  const driveTable = platform === 'win32' && searchesComputer ? readMountTable({ platform, env, detectUsb: true }) : null;
  const [mounts, cloudFolders] = await Promise.all([
    platform === 'win32' ? [] : readMountTable({ platform, env, detectUsb: searchesComputer }),
    findCloudFolders({ platform, homePath, env })
  ]);
  const chooseFolderSkippedMountPoints = skippedMountPointsOf(mounts, platform);
  const skippedMountPoints = new Set(mounts
    .filter((mount) => mount.kind !== 'local' && chooseFolderSkippedMountPoints.has(mount.path))
    .map((mount) => mount.path));
  const excludedKeys = await Promise.all(
    excludedPaths.map(async (excludedPath) => toPathKey(await getRealPath(excludedPath).catch(() => excludedPath)))
  );
  const [syncFolderKeyList, placeholderFolderKeys, knownFolderKeys] = await Promise.all([
    Promise.all(cloudFolders.syncFolders.map(toRealPathKeyWithoutOpening)),
    Promise.all(cloudFolders.placeholderFolders.map(toRealPathKeyWithoutOpening)),
    Promise.all(knownFolders.map(toRealPathKeyWithoutOpening))
  ]);
  const syncFolderKeys = new Set(syncFolderKeyList);
  const isInsideSyncFolder = (key) => syncFolderKeyList.some((syncKey) => isSameOrInside(syncKey, key));
  const isInsidePlaceholderFolder = (filePath) => placeholderFolderKeys.some((folderKey) => isSameOrInside(folderKey, toPathKey(filePath)));
  const cloudKnownFolders = knownFolders.filter((_folderPath, index) => knownFolderKeys[index] && isInsideSyncFolder(knownFolderKeys[index]));
  const planMounts = platform === 'win32' ? toDriveRootMounts(searchesComputer ? locations.filter(isComputerLocation) : locations) : mounts;
  const plan = planWholeComputer({ platform, mounts: planMounts, env });
  const planPruneKeys = plan.prunePaths.map(toResolvedPathKey);
  const isInsidePlanPrune = (rootPath) => planPruneKeys.some((pruneKey) => isSameOrInside(pruneKey, toResolvedPathKey(rootPath)));
  const prunedKeys = new Set(searchesComputer ? [...planPruneKeys, ...plan.mountPrunePaths.map(toResolvedPathKey)] : planPruneKeys);
  HOME_PACKAGE_FOLDERS.forEach((segments) => prunedKeys.add(toResolvedPathKey(path.join(homePath, ...segments))));
  const planRoots = searchesComputer
    ? [...plan.roots, ...plan.volumeRoots, ...cloudKnownFolders]
    : [...plan.roots.filter(isInsidePlanPrune), ...cloudKnownFolders];
  const isLaterDriveRoot = (root) =>
    DRIVE_ROOT.test(root.path) && toResolvedPathKey(root.path) !== toResolvedPathKey(locations.find(isComputerLocation).path);
  const allRoots = toRoots({ locations, planRoots });
  const roots = driveTable ? allRoots.filter((root) => !isLaterDriveRoot(root)) : allRoots;
  const listedLocations = locations.filter((location) => !isWholeComputerLocation(location));
  const creditOf = (folderPath, fallbackLocationId) => innermostLocationOf(listedLocations, folderPath)?.id ?? fallbackLocationId;
  const rootKeys = new Set(roots.map((root) => toResolvedPathKey(root.path)));
  const walkedRootKeys = new Set();
  const statuses = new Map();
  const emitted = new Map();
  const folderQueue = createFolderQueue();
  const pendingCloudChecks = [];
  const cloudChecks = [];
  let cloudCheckError = null;

  const excludedKeySet = new Set(excludedKeys);

  const isExcluded = (key) => excludedKeys.some((excludedKey) => isSameOrInside(excludedKey, key));

  const isSkippedFolder = (name, parentRealPath, childRealPath) => {
    if (isPrunedFolderName(name, parentRealPath) || isPackageFolderName(name, platform) || skippedMountPoints.has(childRealPath)) {
      return true;
    }
    const childKey = toPathKey(childRealPath);
    return rootKeys.has(childKey)
      || prunedKeys.has(childKey)
      || syncFolderKeys.has(childKey)
      || excludedKeySet.has(childKey);
  };

  const setRootStatus = ({ locationId, reportsStatus }, status) => {
    if (reportsStatus) {
      statuses.set(locationId, status);
    }
  };

  const startRoot = async (root) => {
    const { locationId, path: rootPath, reportsStatus } = root;
    if (isUncPath(rootPath, platform)) {
      setRootStatus(root, 'missing');
      return;
    }
    let realPath;
    try {
      realPath = await getRealPath(rootPath);
    } catch (error) {
      setRootStatus(root, toRootStatus(error));
      return;
    }
    const realKey = toPathKey(realPath);
    rootKeys.add(realKey);
    if (walkedRootKeys.has(realKey) || isExcluded(realKey)) {
      return;
    }
    walkedRootKeys.add(realKey);
    const queueFolder = folderQueue.addRoot();
    queueFolder({ folderPath: rootPath, realPath, isRoot: true, depth: toFolderDepth(realPath), locationId, reportsStatus, queueFolder });
  };

  const report = async ({ row, folderPath, entries, name }) => {
    const [collectionName, mtime] = await Promise.all([name || readCollectionName(folderPath, entries), readMtime(folderPath)]);
    onCollection({ path: row.path, name: collectionName, mtime, locationId: row.locationId });
  };

  const checkCloudBatch = async (batch) => {
    const cloudOnlyFiles = await findCloudOnlyFiles(batch.flatMap((found) => found.manifestPaths));
    await Promise.all(batch.map((found) => {
      if (found.manifestPaths.some((filePath) => cloudOnlyFiles.has(filePath))) {
        found.row.hidden = true;
        return null;
      }
      return report(found);
    }));
  };

  const flushCloudChecks = () => {
    if (pendingCloudChecks.length > 0) {
      cloudChecks.push(checkCloudBatch(pendingCloudChecks.splice(0)).catch((error) => {
        cloudCheckError = cloudCheckError || error;
      }));
    }
  };

  const reportIfOnDisk = async (found) => {
    const placeholderManifests = found.manifestPaths.filter(isInsidePlaceholderFolder);
    if (platform === 'win32' && placeholderManifests.length > 0) {
      pendingCloudChecks.push(found);
      if (pendingCloudChecks.length >= CLOUD_CHECK_BATCH_SIZE) {
        flushCloudChecks();
      }
      return;
    }
    if (platform === 'darwin' && (await Promise.all(placeholderManifests.map((filePath) => isDatalessFile(filePath)))).includes(true)) {
      found.row.hidden = true;
      return;
    }
    await report(found);
  };

  const emitWalkedCollection = async (job, entries) => {
    const { folderPath, realPath, isRoot, locationId } = job;
    const key = toPathKey(realPath);
    const earlierRow = emitted.get(key);
    if (earlierRow && !earlierRow.fromRecents) {
      return;
    }
    const row = { path: earlierRow ? earlierRow.path : folderPath, locationId: creditOf(folderPath, locationId) };
    emitted.set(key, row);
    if (!earlierRow && isRoot && (await fs.lstat(folderPath).catch(() => null))?.isSymbolicLink()) {
      row.path = realPath;
    }
    await reportIfOnDisk({ row, folderPath, entries, manifestPaths: entries.filter(isCollectionManifest).map((entry) => path.join(realPath, entry.name)) });
  };

  const visitFolder = async (job) => {
    const { folderPath, realPath, isRoot, depth, locationId, queueFolder } = job;
    let entries;
    try {
      entries = await fs.readdir(folderPath, { withFileTypes: true });
    } catch (error) {
      if (isRoot) {
        setRootStatus(job, toRootStatus(error));
      }
      return;
    }
    if (hasCollectionConfig(entries)) {
      await emitWalkedCollection(job, entries);
      return;
    }
    if (depth >= MAX_FOLDER_DEPTH) {
      return;
    }
    const folderPrefix = withTrailingSeparator(folderPath);
    const realPrefix = withTrailingSeparator(realPath);
    const candidates = entries.filter((entry) =>
      (entry.isDirectory() || entry.isSymbolicLink()) && !isSkippedFolder(entry.name, realPath, `${realPrefix}${entry.name}`));
    const isFolder = await Promise.all(candidates.map((entry) => entry.isDirectory() || isRealFolder(entry, `${folderPrefix}${entry.name}`)));
    candidates.forEach((entry, index) => {
      if (isFolder[index]) {
        queueFolder({ folderPath: `${folderPrefix}${entry.name}`, realPath: `${realPrefix}${entry.name}`, depth: depth + 1, locationId, queueFolder });
      }
    });
  };

  // macOS asks for access to each of these folders on its first read, so reading them one at a
  // time before the parallel walk shows one question at a time and the walk reuses each answer.
  const readProtectedFoldersOneAtATime = async () => {
    if (platform !== 'darwin') {
      return;
    }
    const rootPathKeys = roots.map((root) => toResolvedPathKey(root.path));
    const overlapsARoot = (folderPath) => {
      const folderKey = toResolvedPathKey(folderPath);
      return rootPathKeys.some((rootKey) => isSameOrInside(rootKey, folderKey) || isSameOrInside(folderKey, rootKey));
    };
    const removableMountKeys = new Set(mounts
      .filter((mount) => mount.kind === 'removable' || mount.kind === 'usb')
      .map((mount) => toResolvedPathKey(mount.path)));
    const protectedFolders = [
      ...knownFolders.filter(overlapsARoot),
      ...roots.map((root) => root.path).filter((rootPath) => removableMountKeys.has(toResolvedPathKey(rootPath)))
    ];
    for (const folderPath of protectedFolders) {
      await fs.readdir(folderPath).catch(() => {});
    }
  };

  const addDriveTable = (driveMounts) => {
    const drivePlan = planWholeComputer({ platform, mounts: driveMounts, env });
    drivePlan.prunePaths.forEach((prunePath) => prunedKeys.add(toResolvedPathKey(prunePath)));
    const startedKeys = new Set(roots.map((root) => toResolvedPathKey(root.path)));
    const driveRoots = toRoots({ locations, planRoots: [...drivePlan.roots, ...drivePlan.volumeRoots, ...cloudKnownFolders] })
      .filter((root) => !startedKeys.has(toResolvedPathKey(root.path)));
    driveRoots.forEach((root) => rootKeys.add(toResolvedPathKey(root.path)));
    return driveRoots;
  };

  const walk = () => new Promise((resolve, reject) => {
    let activeVisits = 0;
    let unresolvedRoots = roots.length + (driveTable ? 1 : 0);

    const pump = () => {
      while (activeVisits < CONCURRENCY && !folderQueue.isEmpty()) {
        activeVisits += 1;
        visitFolder(folderQueue.take()).then(() => {
          activeVisits -= 1;
          pump();
        }, reject);
      }
      if (unresolvedRoots === 0 && activeVisits === 0 && folderQueue.isEmpty()) {
        resolve();
      }
    };

    const walkRoot = (root) => {
      startRoot(root).then(() => {
        unresolvedRoots -= 1;
        pump();
      }, reject);
    };

    roots.forEach(walkRoot);
    if (driveTable) {
      driveTable.then((driveMounts) => {
        const driveRoots = addDriveTable(driveMounts);
        unresolvedRoots += driveRoots.length - 1;
        driveRoots.forEach(walkRoot);
        pump();
      }, reject);
    }
    pump();
  });

  const checkRecent = async ({ path: recentPath, name }) => {
    let entries;
    try {
      entries = await fs.readdir(recentPath, { withFileTypes: true });
    } catch (error) {
      return;
    }
    const manifestNames = entries.filter(isCollectionManifest).map((entry) => entry.name);
    if (manifestNames.length === 0) {
      return;
    }
    const realPath = await getRealPath(recentPath).catch(() => null);
    if (!realPath) {
      return;
    }
    const key = toPathKey(realPath);
    if (emitted.has(key)) {
      return;
    }
    const owner = innermostLocationOf(listedLocations, recentPath) || innermostLocationOf(listedLocations, realPath);
    if (!owner && !searchesComputer) {
      return;
    }
    const row = { path: recentPath, locationId: owner ? owner.id : RECENTS_LOCATION_ID, fromRecents: true };
    emitted.set(key, row);
    await reportIfOnDisk({ row, folderPath: recentPath, entries, manifestPaths: manifestNames.map((manifestName) => path.join(realPath, manifestName)), name });
  };

  const checkRecents = async () => {
    const queue = [...recents];
    const checkQueued = async () => {
      while (queue.length > 0) {
        await checkRecent(queue.shift());
      }
    };
    await Promise.all(Array.from({ length: RECENTS_CONCURRENCY }, () => checkQueued()));
  };

  await readProtectedFoldersOneAtATime();
  await Promise.all([walk(), checkRecents()]);
  flushCloudChecks();
  await Promise.all(cloudChecks);
  if (cloudCheckError) {
    throw cloudCheckError;
  }

  const found = new Map();
  emitted.forEach(({ locationId, hidden }) => {
    if (!hidden) {
      found.set(locationId, (found.get(locationId) || 0) + 1);
    }
  });
  return locations.map(({ id }) => ({ id, status: statuses.get(id) || 'done', found: found.get(id) || 0 }));
};

module.exports = {
  scanLocations
};
