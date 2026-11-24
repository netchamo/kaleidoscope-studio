"""Fit Safari->CapCut correction with a smooth RBF, evaluate on held-out image pixels."""
import numpy as np, sys, os, subprocess
from PIL import Image
from scipy.interpolate import RBFInterpolator
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract import apply_lut, N, C, X0, COLS

def frame(path, t):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t), '-i', path, '-frames:v', '1', '-vf',
                          'scale=1080:1920:flags=area:in_color_matrix=bt709:in_range=tv,format=rgb24',
                          '-f', 'rawvideo', '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(1920, 1080, 3).astype(np.float32)

S = np.load('hlg_safari.npy').reshape(-1, 3); K = np.load('hlg_capcut.npy').reshape(-1, 3)
region = (slice(C, C + 1696), slice(X0, X0 + COLS * C))
sv = frame(sys.argv[1], 10.5)[region]; kv = frame(sys.argv[2], 10.5)[region]
h = sv.shape[0] // 2
train_s, train_k = sv[:h].reshape(-1, 3)[::211], kv[:h].reshape(-1, 3)[::211]
test_s, test_k = sv[h:], kv[h:]
lv = np.round(np.arange(N) * 255 / (N - 1))
b, g, r = np.meshgrid(lv, lv, lv, indexing='ij'); grid = np.stack([r, g, b], -1).reshape(-1, 3)
best = None
for use_img in (False, True):
    for sm in (1, 10, 50, 200):
        P = np.concatenate([S] + ([train_s] if use_img else [])); V = np.concatenate([K] + ([train_k] if use_img else []))
        f = RBFInterpolator(P / 255, V, kernel='thin_plate_spline', smoothing=sm, neighbors=200, degree=1)
        lut = np.clip(f(grid / 255), 0, 255).reshape(N, N, N, 3)
        e = np.abs(apply_lut(lut, test_s) - test_k).mean()
        print('img' if use_img else 'lat', sm, 'held-out err %.2f' % e)
        if best is None or e < best[0]: best = (e, lut, use_img, sm)
print('baseline safari vs capcut (held-out) %.2f' % np.abs(test_s - test_k).mean())
e, lut, use_img, sm = best
print('best', e, use_img, sm)
np.save('hlg_fix.npy', lut)
pred = apply_lut(lut, sv)
vis = np.concatenate([sv, pred, kv], 1).clip(0, 255).astype(np.uint8)
Image.fromarray(vis).resize((vis.shape[1] // 3, vis.shape[0] // 3)).save('hlg_fix_verify.jpg', quality=88)
