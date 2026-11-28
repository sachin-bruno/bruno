const os = require('node:os');
const path = require('node:path');
const { runCommand } = require('./run-command');

describe('runCommand', () => {
  it('closes the command input, so a command that reads it to the end still finishes', async () => {
    expect(await runCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 5000)).toBe('');
  });

  it('gives null for a command that fails or does not exist', async () => {
    expect(await runCommand(process.execPath, ['-e', 'process.exit(3)'], 5000)).toBeNull();
    expect(await runCommand(path.join(os.tmpdir(), 'bruno-missing-command'), [], 5000)).toBeNull();
  });
});
