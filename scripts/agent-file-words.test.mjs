import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileWords, masked } from './agent.mjs';

// Bug: a token passed as @file:<path> reaches the app as the literal path, or prints in a reply or an error. Fails if the op does not carry the file's text, or the printed line still holds it raw or URL-encoded.
test('an @file word is the file text and is masked in what the drive prints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-file-words-'));
  const path = join(dir, 'token');
  writeFileSync(path, 'a/b+c=\n', { mode: 0o600 });
  const secrets = [];
  expect(fileWords(`type session-refresh-token @file:${path}`, secrets)).toBe('type session-refresh-token a/b+c=');
  expect(masked('typed "session-refresh-token" value="a/b+c=" url=a%2Fb%2Bc%3D', secrets)).toBe('typed "session-refresh-token" value="@file" url=@file');
});

// Bug: an empty token file types nothing and the drive goes on signed out. Fails if an empty file does not stop the op.
test('an empty @file stops the op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-file-words-'));
  const path = join(dir, 'token');
  writeFileSync(path, '\n');
  expect(() => fileWords(`type x @file:${path}`, [])).toThrow(/is empty/);
});
