import { cp, mkdir, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
if (relative(root, output) !== 'dist' || dirname(output) !== root) throw new Error('无效的构建目录。');
try {
  if ((await lstat(output)).isSymbolicLink()) throw new Error('dist 不能是符号链接。');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'styles.css', 'admin.html', 'admin.css']) await cp(resolve(root, name), resolve(output, name));
await cp(resolve(root, 'assets'), resolve(output, 'assets'), { recursive: true });
await mkdir(resolve(output, 'deploy'));
for (const name of ['install.sh', 'xiangqi.service', 'nginx.http.conf', 'nginx.https.conf', 'README.md']) {
  const content = await readFile(resolve(root, 'deploy', name), 'utf8');
  await writeFile(resolve(output, 'deploy', name), content.replace(/\r\n/g, '\n'));
}
for (const directory of ['src', 'scripts']) {
  await mkdir(resolve(output, directory));
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(js|mjs)$/.test(entry.name) || entry.name === 'build.mjs') continue;
    await cp(resolve(root, directory, entry.name), resolve(output, directory, entry.name));
  }
}
const sourcePackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await writeFile(resolve(output, 'package.json'), JSON.stringify({
  name: sourcePackage.name, version: sourcePackage.version, private: true, type: 'module',
  scripts: { start: 'node scripts/serve.mjs' }, engines: sourcePackage.engines,
}, null, 2) + '\n');
console.log('构建完成：dist/。使用 npm run start:prod 启动，或将 dist 上传后执行 npm start。');
