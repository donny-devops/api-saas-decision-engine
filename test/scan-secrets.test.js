import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('../scripts/scan-secrets.js', import.meta.url));

test('secret scanner runs and reports findings while honoring allow markers', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    const file = join(cwd, 'fixture.txt');
    const fakeKey = 'AK' + 'IA' + 'A'.repeat(16);
    writeFileSync(file, `${fakeKey} secret-scan:allow\n`);
    execFileSync('git', ['add', 'fixture.txt'], { cwd });

    const clean = spawnSync(process.execPath, [scanner], { cwd, encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /secret scan clean/);

    writeFileSync(file, `${fakeKey} secret-scan:allow\n${fakeKey}\n`);
    execFileSync('git', ['add', 'fixture.txt'], { cwd });
    for (const args of [[], ['--staged']]) {
      const result = spawnSync(process.execPath, [scanner, ...args], { cwd, encoding: 'utf8' });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /1 potential secret\(s\)/);
      assert.match(result.stderr, /fixture\.txt:2\s+\[aws-access-key\]/);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
