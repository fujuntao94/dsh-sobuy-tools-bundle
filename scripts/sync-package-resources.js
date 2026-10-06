import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const feishuPackageTarget = resolve(root, 'feishu');
const feishuComponentTarget = resolve(root, 'components/feishu');
const packageTarget = resolve(root, 'database');
const componentTarget = resolve(root, 'components/database');

await rm(feishuPackageTarget, { force: true, recursive: true });
await mkdir(feishuPackageTarget, { recursive: true });
await cp(resolve(feishuComponentTarget, 'locale'), resolve(feishuPackageTarget, 'locale'), { recursive: true });
await cp(resolve(feishuComponentTarget, 'icon.svg'), resolve(feishuPackageTarget, 'icon.svg'));
await cp(resolve(feishuComponentTarget, 'package.json'), resolve(feishuPackageTarget, 'package.json'));

await rm(packageTarget, { force: true, recursive: true });
await mkdir(packageTarget, { recursive: true });
await cp(resolve(componentTarget, 'locale'), resolve(packageTarget, 'locale'), { recursive: true });
await cp(resolve(componentTarget, 'icon.svg'), resolve(packageTarget, 'icon.svg'));
await cp(resolve(componentTarget, 'package.json'), resolve(packageTarget, 'package.json'));

console.log('已同步飞书与数据库组件展示资源到对应入口。');
