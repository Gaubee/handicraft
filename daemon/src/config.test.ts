/**
 * config 单测（W1.2 任务门）：模板自建 0600、原位回写保序、默认值族、半配置判定。
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ENV_TEMPLATE,
  isImgConfigured,
  isLlmConfigured,
  loadConfig,
  parseDotenv,
  saveEnvValues,
} from './config.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'handicraft-config-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('.env 模板自建', () => {
  it('缺失时自动创建（0600）且含全部键族', () => {
    const dir = tempDir();
    const envFile = path.join(dir, '.env');
    loadConfig({ envFile });
    expect(existsSync(envFile)).toBe(true);
    const mode = statSync(envFile).mode & 0o777;
    expect(mode).toBe(0o600);
    const text = readFileSync(envFile, 'utf8');
    for (const key of [
      'ADMIN_USERNAME',
      'ADMIN_PASSWORD',
      'JWT_SECRET',
      'IMG_BASE_URL',
      'IMG_API_KEY',
      'IMG_MODEL',
      'LLM_PROVIDER',
      'LLM_BASE_URL',
      'LLM_API_KEY',
      'LLM_MODEL',
      'ALLOW_ANONYMOUS=1',
      'HOST',
      'PORT',
    ]) {
      expect(text).toContain(key);
    }
  });
});

describe('原位回写（zhumo 模式：注释与行序保留）', () => {
  it('既有行原位替换；缺失键追加尾部；注释行原样', () => {
    const dir = tempDir();
    const envFile = path.join(dir, '.env');
    writeFileSync(
      envFile,
      ['# 首注释', 'ADMIN_USERNAME=', 'JWT_SECRET=old', '# 尾注释', ''].join('\n'),
      'utf8',
    );
    saveEnvValues(envFile, { ADMIN_USERNAME: 'boss', JWT_SECRET: 'new', IMG_API_KEY: 'k1' });
    const lines = readFileSync(envFile, 'utf8').split('\n');
    expect(lines[0]).toBe('# 首注释');
    expect(lines[1]).toBe('ADMIN_USERNAME=boss');
    expect(lines[2]).toBe('JWT_SECRET=new');
    expect(lines[3]).toBe('# 尾注释');
    expect(lines.some((l) => l === 'IMG_API_KEY=k1')).toBe(true);
  });
});

describe('解析与默认值', () => {
  it('process.env 优先于 .env；引号值剥离', () => {
    const parsed = parseDotenv('A=plain\nB="quoted"\n# c\nexport D=expo\n');
    expect(parsed).toEqual({ A: 'plain', B: 'quoted', D: 'expo' });
    const dir = tempDir();
    const envFile = path.join(dir, '.env');
    writeFileSync(envFile, 'PORT=9000\n', 'utf8');
    const config = loadConfig({ envFile, processEnv: { PORT: '9100' } });
    expect(config.port).toBe(9100);
  });
  it('默认族：127.0.0.1:8317 + allowAnonymous 开 + 缺省数据根/webui', () => {
    const dir = tempDir();
    const config = loadConfig({ envFile: path.join(dir, '.env') });
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8317);
    expect(config.allowAnonymous).toBe(true);
    expect(config.dataRoot).toMatch(/data$/);
    expect(config.webuiDir).toMatch(/rhinestone-studio[/\\]dist$/);
  });
  it('ALLOW_ANONYMOUS=0 关闭；DATA_ROOT 相对 .env 目录解析', () => {
    const dir = tempDir();
    const envFile = path.join(dir, '.env');
    writeFileSync(envFile, 'ALLOW_ANONYMOUS=0\nDATA_ROOT=sub/data\n', 'utf8');
    const config = loadConfig({ envFile });
    expect(config.allowAnonymous).toBe(false);
    expect(config.dataRoot).toBe(path.resolve(dir, 'sub/data'));
  });
});

describe('半配置=未配置（design §2）', () => {
  it('IMG 只配 baseUrl 不配 key → 整体未配置；配齐 → 已配置', () => {
    expect(isImgConfigured({ baseUrl: 'https://x', apiKey: '', model: 'm' })).toBe(false);
    expect(isImgConfigured({ baseUrl: 'https://x', apiKey: 'k', model: 'm' })).toBe(true);
  });
  it('LLM 同语义', () => {
    expect(isLlmConfigured({ provider: 'p', baseUrl: 'b', apiKey: '', model: 'm' })).toBe(false);
    expect(isLlmConfigured({ provider: 'p', baseUrl: 'b', apiKey: 'k', model: 'm' })).toBe(true);
  });
});
