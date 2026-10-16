/**
 * Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher)
 * on a grid. `f` holds 0 at sources and a large value elsewhere; it is
 * replaced by the squared distance (in cells) to the nearest source.
 */
export function edt2d(f: Float32Array, w: number, h: number): void {
  const n = Math.max(w, h);
  const line = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const zz = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = f[y * w + x]!;
    edt1d(line, h, out, v, zz);
    for (let y = 0; y < h; y++) f[y * w + x] = out[y]!;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) line[x] = f[y * w + x]!;
    edt1d(line, w, out, v, zz);
    for (let x = 0; x < w; x++) f[y * w + x] = out[x]!;
  }
}

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dq = q - v[k]!;
    d[q] = dq * dq + f[v[k]!]!;
  }
}
