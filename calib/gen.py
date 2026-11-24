"""Generate a calibration master video for sampling CapCut filters.

Layout (1080x1920, vertical):
  - 32px cells, 33 columns x 60 rows, left/right margin 12px.
  - row 0  : alignment marker (alternating black/white cells)
  - row 59 : page id bits (cells 0..7 encode page number, white=1) + fixed pattern
  - rows 1..58 : color patches, 33*58 = 1914 per page
  - pages 0..2 hold the 17^3 = 4913 lattice colors (r fastest, then g, then b)
  - page 3: verification image (user's reference frame) + gray ramp
Each page is held for 3 seconds.
"""
import sys
import numpy as np
from PIL import Image

W, H, C = 1080, 1920, 32
COLS, ROWS = 33, 60
X0 = (W - COLS * C) // 2  # 12
N = 17
LEVELS = np.round(np.arange(N) * 255 / (N - 1)).astype(np.uint8)
PER_PAGE = COLS * (ROWS - 2)


def lattice():
    idx = np.arange(N ** 3)
    r, g, b = idx % N, (idx // N) % N, idx // (N * N)
    return np.stack([LEVELS[r], LEVELS[g], LEVELS[b]], 1)


def cell(img, row, col, rgb):
    y, x = row * C, X0 + col * C
    img[y:y + C, x:x + C] = rgb


def markers(img, page):
    for col in range(COLS):
        cell(img, 0, col, 255 if col % 2 == 0 else 0)
    for col in range(COLS):
        if col < 8:
            v = 255 if (page >> col) & 1 else 0
        else:
            v = 255 if col % 2 == 1 else 0
        cell(img, ROWS - 1, col, v)


def patch_pages():
    cols = lattice()
    pages = []
    for p in range(int(np.ceil(len(cols) / PER_PAGE))):
        img = np.full((H, W, 3), 128, np.uint8)
        chunk = cols[p * PER_PAGE:(p + 1) * PER_PAGE]
        for i, rgb in enumerate(chunk):
            cell(img, 1 + i // COLS, i % COLS, rgb)
        markers(img, p)
        pages.append(img)
    return pages


def verify_page(ref_path, page):
    img = np.full((H, W, 3), 0, np.uint8)
    ref = Image.open(ref_path).convert('RGB').crop((300, 40, 900, 1100)).resize((COLS * C, 1696), Image.LANCZOS)
    img[C:C + 1696, X0:X0 + COLS * C] = np.asarray(ref)
    # gray ramp + saturated ramps under the photo
    y0 = C + 1696
    ramp = np.linspace(0, 255, COLS * C).astype(np.uint8)
    img[y0:y0 + 64, X0:X0 + COLS * C] = ramp[None, :, None]
    hue = np.zeros((COLS * C, 3), np.uint8)
    for i in range(COLS * C):
        t = i / (COLS * C) * 6
        k = int(t) % 6
        f = t - int(t)
        hue[i] = [(1, 1 - f, 0, 0, f, 1)[k] * 255, (f, 1, 1, 1 - f, 0, 0)[k] * 255, (0, 0, f, 1, 1, 1 - f)[k] * 255]
    img[y0 + 64:y0 + 128, X0:X0 + COLS * C] = hue[None]
    markers(img, page)
    return img


if __name__ == '__main__':
    out, ref = sys.argv[1], sys.argv[2]
    pages = patch_pages()
    pages.append(verify_page(ref, len(pages)))
    for i, p in enumerate(pages):
        Image.fromarray(p).save(f'{out}/page{i}.png')
    print(len(pages), 'pages')
