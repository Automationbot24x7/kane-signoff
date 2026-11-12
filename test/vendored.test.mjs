import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The demo project carries a vendored copy of the gate. It must match the source.
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)).map((x) => join(f, x)) : [f]));
for (const dir of ['src', 'bin', 'viewer']) {
  test(`examples/tabby vendored ${dir}/ matches the source`, () => {
    const vend = join('examples', 'tabby', '.signoff', 'tool', dir);
    for (const f of walk(dir)) {
      const a = readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');
      const b = readFileSync(join(vend, f), 'utf8').replace(/\r\n/g, '\n');
      assert.equal(b, a, `${dir}/${f} is out of date in examples/tabby: run init there again`);
    }
  });
}
