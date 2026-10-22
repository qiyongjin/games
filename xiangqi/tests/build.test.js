import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('standalone build retains both bundled audio files and deployment files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'yibu-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['index.html', 'styles.css', 'admin.html', 'admin.css', 'package.json', 'assets', 'src', 'scripts', 'deploy']) {
    await cp(new URL('../' + name, import.meta.url), join(root, name), { recursive: true });
  }
  await execute(process.execPath, ['scripts/build.mjs'], { cwd: root });
  const source = await readFile(join(root, 'assets', 'check-march.m4a'));
  const built = await readFile(join(root, 'dist', 'assets', 'check-march.m4a'));
  assert.equal(built.equals(source), true);
  assert.equal(built.subarray(4, 8).toString(), 'ftyp');
  const collision = await readFile(join(root, 'assets', 'move-collision.mp3'));
  const builtCollision = await readFile(join(root, 'dist', 'assets', 'move-collision.mp3'));
  assert.equal(builtCollision.equals(collision), true);
  for (const path of ['src/battle-audio.js', 'scripts/server.mjs', 'scripts/serve.mjs', 'deploy/install.sh']) {
    assert.equal((await stat(join(root, 'dist', path))).isFile(), true, path);
  }
  assert.equal(JSON.parse(await readFile(join(root, 'dist', 'package.json'), 'utf8')).scripts.start, 'node scripts/serve.mjs');
});
