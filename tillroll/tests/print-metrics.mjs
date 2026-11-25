import {sets, scoreSet} from './harness.mjs';
const out = Object.fromEntries(sets.map(s => [s, scoreSet(s)]));
console.log(JSON.stringify(out, null, 2));
