import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync, crc32 } from 'node:zlib';
import { openZip } from '../src/zip.mjs';

// Build a two-entry zip (one stored, one deflated) by hand.
function makeZip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, text, deflate] of files) {
    const data = Buffer.from(text); const comp = deflate ? deflateRawSync(data) : data; const n = Buffer.from(name);
    const crc = crc32 ? crc32(data) : 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, comp); centrals.push(ch, n); offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('reads stored and deflated entries', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'signoff-zip-')), 'x.evidence');
  writeFileSync(p, makeZip([['run.yaml', 'status: failed\n', false], ['tests/a/result.yaml', 'status: failed\n'.repeat(50), true]]));
  const z = openZip(p);
  assert.deepEqual(z.names(), ['run.yaml', 'tests/a/result.yaml']);
  assert.equal(z.text('run.yaml'), 'status: failed\n');
  assert.equal(z.text('tests/a/result.yaml'), 'status: failed\n'.repeat(50));
  assert.equal(z.text('missing'), null);
});
