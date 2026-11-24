"""Extract a 3D LUT from a calibration master that went through a filter.

usage: python3 extract.py <exported_video> <out_prefix> [pages_dir]
Writes <out_prefix>.cube, <out_prefix>_verify.jpg and prints accuracy.
"""
import json
import subprocess
import sys
import numpy as np
from PIL import Image

W, H, C, COLS, ROWS, N = 1080, 1920, 32, 33, 60, 17
X0 = (W - COLS * C) // 2
PER_PAGE = COLS * (ROWS - 2)


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                          'stream=width,height,color_space,color_transfer,duration:format=duration', '-of', 'json', path],
                         capture_output=True, text=True).stdout
    j = json.loads(out)
    s = j['streams'][0]
    dur = float(s.get('duration') or j['format']['duration'])
    return s, dur


def frames(path, times, matrix):
    for t in times:
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.3f}', '-i', path, '-frames:v', '1', '-vf',
                              f'scale={W}:{H}:flags=area:in_color_matrix={matrix}:in_range=tv,format=rgb24',
                              '-f', 'rawvideo', '-'], capture_output=True).stdout
        if len(raw) == W * H * 3:
            yield t, np.frombuffer(raw, np.uint8).reshape(H, W, 3).astype(np.float32)


def cells(img, row):
    y = row * C + C // 2
    return np.array([np.median(img[y - 8:y + 8, X0 + c * C + 8:X0 + c * C + 24].reshape(-1, 3), 0) for c in range(COLS)])


def page_of(img):
    top = cells(img, 0).mean(1)
    hi, lo = top[0::2].mean(), top[1::2].mean()
    if hi - lo < 25:
        return None
    thr = (hi + lo) / 2
    if not np.all(top[0::2] > thr) or not np.all(top[1::2] < thr):
        return None
    bot = cells(img, ROWS - 1).mean(1)
    fixed = bot[8:]
    exp = np.array([(c % 2 == 1) for c in range(8, COLS)])
    if not np.all((fixed > thr) == exp):
        return None
    return int(sum(1 << i for i in range(8) if bot[i] > thr))


def lattice_levels():
    return np.round(np.arange(N) * 255 / (N - 1))


def apply_lut(lut, img):
    """trilinear; lut shape (N,N,N,3) indexed [b,g,r]; img float 0..255"""
    x = img / 255 * (N - 1)
    i0 = np.clip(np.floor(x).astype(int), 0, N - 2)
    f = x - i0
    r0, g0, b0 = i0[..., 0], i0[..., 1], i0[..., 2]
    fr, fg, fb = f[..., 0:1], f[..., 1:2], f[..., 2:3]
    out = 0
    for db in (0, 1):
        for dg in (0, 1):
            for dr in (0, 1):
                w = (fr if dr else 1 - fr) * (fg if dg else 1 - fg) * (fb if db else 1 - fb)
                out = out + w * lut[b0 + db, g0 + dg, r0 + dr]
    return out


def main():
    path, prefix = sys.argv[1], sys.argv[2]
    pages_dir = sys.argv[3] if len(sys.argv) > 3 else 'pages'
    s, dur = probe(path)
    matrix = 'bt2020' if s.get('color_space', '').startswith('bt2020') else 'bt709'
    if s.get('color_transfer') in ('arib-std-b67', 'smpte2084'):
        print('WARNING: export is HDR (%s); export from CapCut in SDR for an accurate LUT' % s['color_transfer'])
    print('input', s.get('width'), 'x', s.get('height'), 'dur %.2f' % dur, 'matrix', matrix)
    acc = {}
    for t, img in frames(path, np.arange(0.4, dur - 0.1, 0.35), matrix):
        p = page_of(img)
        if p is None:
            continue
        acc.setdefault(p, []).append(img)
    print('pages found:', {k: len(v) for k, v in sorted(acc.items())})
    npages = int(np.ceil(N ** 3 / PER_PAGE))
    missing = [p for p in range(npages + 1) if p not in acc]
    if missing:
        print('missing pages', missing)
        if any(p < npages for p in missing):
            sys.exit(1)
    samples = []
    for p in range(npages):
        img = np.median(np.stack(acc[p]), 0)
        for row in range(1, ROWS - 1):
            samples.append(cells(img, row))
    samples = np.concatenate(samples)[:N ** 3]
    lut = samples.reshape(N, N, N, 3)  # [b,g,r]
    with open(prefix + '.cube', 'w') as f:
        f.write('TITLE "capcut-sample"\nLUT_3D_SIZE %d\n' % N)
        for v in samples:
            f.write('%.6f %.6f %.6f\n' % tuple(np.clip(v / 255, 0, 1)))
    np.save(prefix + '.npy', lut)
    if npages in acc:
        src = np.asarray(Image.open(f'{pages_dir}/page{npages}.png').convert('RGB')).astype(np.float32)
        got = np.median(np.stack(acc[npages]), 0)
        region = (slice(C, C + 1696), slice(X0, X0 + COLS * C))
        pred = apply_lut(lut, src[region])
        err = np.abs(pred - got[region])
        ident = np.abs(src[region] - got[region])
        print('verify: mean abs error %.2f (filter strength, i.e. src vs filtered: %.2f), p95 %.2f'
              % (err.mean(), ident.mean(), np.percentile(err.mean(-1), 95)))
        # spatial residual: does the filter do something a LUT can't (vignette, glow, grain)?
        e = (pred - got[region]).mean(-1)
        hh, ww = e.shape
        print('residual by zone  center %.2f  edges %.2f' % (
            e[hh // 4:3 * hh // 4, ww // 4:3 * ww // 4].mean(),
            np.concatenate([e[:hh // 8].ravel(), e[-hh // 8:].ravel()]).mean()))
        vis = np.concatenate([src[region], pred, got[region]], 1).clip(0, 255).astype(np.uint8)
        Image.fromarray(vis).resize((vis.shape[1] // 3, vis.shape[0] // 3)).save(prefix + '_verify.jpg', quality=88)


if __name__ == '__main__':
    main()
