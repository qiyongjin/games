import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';

/** Single-writer transactions: a failed save never replaces the live snapshot. */
export async function openStorage(directory, initialValue) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'state.json');
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
    if (value?.version !== 1 || !value.admin || !Array.isArray(value.visitors)
      || !Array.isArray(value.games) || !Array.isArray(value.feedback)) throw new Error('数据文件格式无效');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`无法读取统计数据，请保留原文件后检查：${path}`, { cause: error });
    value = await initialValue();
    await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  }
  await chmod(path, 0o600).catch(() => {});
  let pending = Promise.resolve();
  return {
    path,
    get value() { return value; },
    update(mutator) {
      const task = pending.then(async () => {
        const next = structuredClone(value);
        const result = await mutator(next);
        const temporary = `${path}.tmp`;
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, path);
        value = next;
        return result;
      });
      pending = task.catch(() => {});
      return task;
    },
    flush() { return pending; },
  };
}
