"""HLG (iPhone-style HDR) calibration master.

Same layout as gen.py, but patch values are HLG code values (BT.2020 R'G'B', 0..1)
on a 17^3 lattice. Page 3 holds the reference photo converted SDR -> HLG
(BT.2408 style: 203 nit reference white, 1000 nit HLG, gamma 1.2).
Writes raw rgb48le frames (one per page, last repeated) + 8-bit PNGs of the
code values for the extractor's verification step.
"""
import sys
import numpy as np
from PIL import Image
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import gen

A, B, Cc = 0.17883277, 0.28466892, 0.55991073
M709_2020 = np.array([[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]])


def srgb_to_lin(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def hlg_oetf(e):
    e = np.clip(e, 0, 1)
    return np.where(e <= 1 / 12, np.sqrt(3 * e), A * np.log(np.maximum(12 * e - B, 1e-9)) + Cc)


def sdr_to_hlg(rgb8):
    lin = srgb_to_lin(rgb8 / 255.0) @ M709_2020.T          # display light, 1.0 = 203 nit
    fd = lin * 203 / 1000                                   # relative to 1000 nit peak
    yd = fd @ np.array([0.2627, 0.6780, 0.0593])
    ys = np.maximum(yd, 1e-9) ** (1 / 1.2)
    es = fd / np.maximum(ys, 1e-9)[..., None] ** 0.2         # inverse OOTF
    return hlg_oetf(es)


if __name__ == '__main__':
    out, ref = sys.argv[1], sys.argv[2]
    pages = [p.astype(np.float64) / 255 for p in gen.patch_pages()]   # lattice levels are exact k/16
    v = gen.verify_page(ref, len(pages)).astype(np.float64)
    region = (slice(gen.C, gen.H - gen.C), slice(gen.X0, gen.X0 + gen.COLS * gen.C))
    v[region] = sdr_to_hlg(v[region]) * 255
    pages.append(v / 255)
    with open(f'{out}/hlg_pages.raw', 'wb') as f:
        for p in pages + [pages[-1]]:
            f.write(np.round(p * 65535).astype('<u2').tobytes())
    for i, p in enumerate(pages):
        Image.fromarray(np.round(p * 255).astype(np.uint8)).save(f'{out}/page{i}.png')
    print(len(pages), 'pages')
