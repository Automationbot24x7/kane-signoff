// A small YAML reader for the files inside Kane evidence packs
// (block maps, block lists, quoted and folded plain scalars). Not a full YAML parser.

function scalar(s) {
  s = s.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"')) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  if (s === '[]') return [];
  if (s === '{}') return {};
  return s;
}

export function parseYaml(text) {
  if (!text) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n')
    .map((raw) => ({ raw, indent: raw.match(/^ */)[0].length, body: raw.trim() }))
    .filter((l) => l.body !== '' && !l.body.startsWith('#') && l.body !== '---');
  let i = 0;

  // Join continuation lines of a quoted or plain multi-line scalar.
  function readScalar(first, minIndent) {
    let s = first;
    const open = s.startsWith("'") ? "'" : s.startsWith('"') ? '"' : null;
    const closed = () => open && s.length > 1 && s.endsWith(open) && !(open === "'" && s.endsWith("''") && !s.endsWith("'''"));
    if (open && closed()) return scalar(s);
    if (s === '|' || s === '>' || s === '|-' || s === '>-') {
      const parts = [];
      while (i < lines.length && lines[i].indent >= minIndent) parts.push(lines[i++].body);
      return parts.join(s.startsWith('|') ? '\n' : ' ');
    }
    while (i < lines.length && lines[i].indent >= minIndent && !(open ? false : /^[\w"'-][^:]*:(\s|$)/.test(lines[i].body)) && !lines[i].body.startsWith('- ')) {
      s += ' ' + lines[i++].body;
      if (open && closed()) break;
    }
    return scalar(s);
  }

  function block(indent) {
    if (i >= lines.length) return null;
    if (lines[i].body.startsWith('- ') || lines[i].body === '-') return list(lines[i].indent);
    return map(indent);
  }

  function map(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].body.startsWith('- ')) {
      const m = lines[i].body.match(/^("[^"]*"|'[^']*'|[^:]+):(?:\s+(.*))?$/);
      if (!m) { i++; continue; }
      const key = String(scalar(m[1]));
      const rest = m[2] ?? '';
      i++;
      if (rest === '') {
        if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && lines[i].body.startsWith('- ')))) obj[key] = block(lines[i].indent);
        else obj[key] = null;
      } else obj[key] = readScalar(rest, indent + 1);
    }
    return obj;
  }

  function list(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && (lines[i].body.startsWith('- ') || lines[i].body === '-')) {
      const rest = lines[i].body.slice(1).trim();
      if (rest === '') { i++; arr.push(block(lines[i]?.indent ?? indent + 2)); continue; }
      if (/^("[^"]*"|'[^']*'|[^:'"]+):(\s|$)/.test(rest)) {
        // "- key: value" starts a map whose keys sit at indent+2
        lines[i] = { raw: lines[i].raw, indent: indent + 2, body: rest };
        arr.push(map(indent + 2));
      } else { i++; arr.push(readScalar(rest, indent + 2)); }
    }
    return arr;
  }

  return block(lines[0]?.indent ?? 0);
}
