import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function hasExplicitNoEmitFalse(config: unknown): boolean {
  if (typeof config !== 'object' || config === null) {
    return false;
  }

  const compilerOptions = Reflect.get(config, 'compilerOptions');
  if (typeof compilerOptions !== 'object' || compilerOptions === null) {
    return false;
  }

  return Reflect.get(compilerOptions, 'noEmit') === false;
}

describe('TypeScript build configurations', () => {
  it('emits the API runtime entrypoint', () => {
    const configPath = resolve(__dirname, '..', 'tsconfig.build.json');

    expect(hasExplicitNoEmitFalse(readJson(configPath))).toBe(true);
  });

  it('emits the shared package consumed by the API', () => {
    const configPath = resolve(
      __dirname,
      '..',
      '..',
      '..',
      'packages',
      'shared',
      'tsconfig.json',
    );

    expect(hasExplicitNoEmitFalse(readJson(configPath))).toBe(true);
  });
});
