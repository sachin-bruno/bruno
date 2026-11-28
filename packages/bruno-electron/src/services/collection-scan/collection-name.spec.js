const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readCollectionName } = require('./collection-name');

describe('readCollectionName', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bruno-collection-name-')));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const collectionWith = (files) => {
    const folderPath = path.join(tempDir, 'my-collection');
    fs.mkdirSync(folderPath, { recursive: true });
    Object.entries(files).forEach(([name, content]) => fs.writeFileSync(path.join(folderPath, name), content));
    return folderPath;
  };

  const nameOf = (folderPath) => readCollectionName(folderPath, fs.readdirSync(folderPath, { withFileTypes: true }));

  it('reads info.name from opencollection.yml', async () => {
    const folderPath = collectionWith({ 'opencollection.yml': 'opencollection: 1.0.0\ninfo:\n  summary: Orders API\n  name: Orders\n' });

    expect(await nameOf(folderPath)).toBe('Orders');
  });

  it('removes the quotes around a yml name', async () => {
    const folderPath = collectionWith({ 'opencollection.yml': 'info:\n  name: "Orders: v2"\n' });

    expect(await nameOf(folderPath)).toBe('Orders: v2');
  });

  it('trims the spaces around a yml name', async () => {
    const folderPath = collectionWith({ 'opencollection.yml': 'info:\n  name:    Orders   \n' });

    expect(await nameOf(folderPath)).toBe('Orders');
  });

  it.each([
    ['escaped quotes', 'name: "Orders \\"v2\\""', 'Orders "v2"'],
    ['a trailing comment', 'name: Orders # main API', 'Orders'],
    ['an unquoted colon', 'name: Orders: v2', 'Orders: v2'],
    ['text that looks like a YAML marker', 'name: --- Orders', '--- Orders'],
    ['only digits', 'name: 2024', '2024']
  ])('reads a yml name with %s', async (_description, line, expected) => {
    const folderPath = collectionWith({ 'opencollection.yml': `info:\n  ${line}\n` });

    expect(await nameOf(folderPath)).toBe(expected);
  });

  it('reads a top-level yml name when there is no info.name', async () => {
    const folderPath = collectionWith({ 'opencollection.yml': 'name: \'Legacy\'\n' });

    expect(await nameOf(folderPath)).toBe('Legacy');
  });

  it('reads a yml file written with Windows line endings', async () => {
    const folderPath = collectionWith({ 'opencollection.yml': 'opencollection: 1.0.0\r\ninfo:\r\n  summary: Orders API\r\n  name: Orders\r\n' });

    expect(await nameOf(folderPath)).toBe('Orders');
  });

  it('prefers opencollection.yml over bruno.json', async () => {
    const folderPath = collectionWith({
      'opencollection.yml': 'info:\n  name: From yml\n',
      'bruno.json': JSON.stringify({ name: 'From json' })
    });

    expect(await nameOf(folderPath)).toBe('From yml');
  });

  it('falls back to bruno.json when opencollection.yml is empty', async () => {
    const folderPath = collectionWith({ 'opencollection.yml': '', 'bruno.json': JSON.stringify({ name: 'From json' }) });

    expect(await nameOf(folderPath)).toBe('From json');
  });

  it('reads the name from bruno.json', async () => {
    const folderPath = collectionWith({ 'bruno.json': JSON.stringify({ version: '1', name: ' Payments ', type: 'collection' }) });

    expect(await nameOf(folderPath)).toBe('Payments');
  });

  it('finds the name in a bruno.json that is not valid JSON', async () => {
    const folderPath = collectionWith({ 'bruno.json': '{ "version": "1", "name": "Payments", ' });

    expect(await nameOf(folderPath)).toBe('Payments');
  });

  it.each([
    ['a bruno.json without a name', { 'bruno.json': JSON.stringify({ version: '1' }) }],
    ['an opencollection.yml without a name', { 'opencollection.yml': 'opencollection: 1.0.0\n' }],
    ['no config file it can read', {}]
  ])('uses the folder name for %s', async (_description, files) => {
    const folderPath = collectionWith(files);

    expect(await nameOf(folderPath)).toBe('my-collection');
  });

  it.each([
    ['opencollection.yml', 'info:\n  name: Orders\n', 'Orders'],
    ['bruno.json', JSON.stringify({ name: 'Payments' }), 'Payments']
  ])('reads a listed %s without checking it first, and opens no other file', async (manifestName, content, expected) => {
    const folderPath = collectionWith({ [manifestName]: content, 'collection.bru': '' });
    const stat = jest.spyOn(fsPromises, 'stat');
    const open = jest.spyOn(fsPromises, 'open');

    expect(await nameOf(folderPath)).toBe(expected);
    expect(stat).not.toHaveBeenCalled();
    expect(open.mock.calls.map(([target]) => target)).toEqual([path.join(folderPath, manifestName)]);
  });

  (process.platform === 'win32' ? it.skip : it)('checks a manifest that is a link before reading it', async () => {
    const manifest = path.join(tempDir, 'bruno.json');
    fs.writeFileSync(manifest, JSON.stringify({ name: 'Linked' }));
    const folderPath = collectionWith({});
    fs.symlinkSync(manifest, path.join(folderPath, 'bruno.json'));
    const stat = jest.spyOn(fsPromises, 'stat');

    expect(await nameOf(folderPath)).toBe('Linked');
    expect(stat).toHaveBeenCalledWith(path.join(folderPath, 'bruno.json'));
  });

  it('checks a manifest listed as a named pipe before reading it', async () => {
    const folderPath = collectionWith({ 'bruno.json': JSON.stringify({ name: 'Payments' }) });
    const listedAsPipe = { name: 'bruno.json', isFile: () => false, isFIFO: () => true, isDirectory: () => false, isSymbolicLink: () => false };
    const stat = jest.spyOn(fsPromises, 'stat');

    expect(await readCollectionName(folderPath, [listedAsPipe])).toBe('Payments');
    expect(stat).toHaveBeenCalledWith(path.join(folderPath, 'bruno.json'));
  });

  it('looks for a manifest listed in another letter case by its lowercase name', async () => {
    const folderPath = collectionWith({ 'OpenCollection.yml': 'info:\n  name: From yml\n', 'bruno.json': JSON.stringify({ name: 'From json' }) });
    const lowercasePath = path.join(folderPath, 'opencollection.yml');
    const stat = jest.spyOn(fsPromises, 'stat');

    expect(await nameOf(folderPath)).toBe(fs.existsSync(lowercasePath) ? 'From yml' : 'From json');
    expect(stat).toHaveBeenCalledWith(lowercasePath);
  });
});
