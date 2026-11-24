import numpy as np, sys, os
from PIL import Image
from scipy.interpolate import RBFInterpolator
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract import apply_lut, N, C, X0, COLS
from compose2 import frame, region, sv, kv, h, grid  # reuses loaded frames
S = np.load('hlg_safari.npy'); K = np.load('hlg_capcut.npy')
code = np.asarray(Image.open('pages_hlg/page3.png').convert('RGB')).astype(np.float32)[region]
# realistic codes: top half of the reference + jittered versions (more skin/warm/dark variety)
rng = np.random.default_rng(0)
base = code[:h].reshape(-1, 3)[::50]
jit = np.clip(base[rng.integers(0, len(base), 20000)] * rng.uniform(.6, 1.25, (20000, 1)) + rng.normal(0, 12, (20000, 3)), 0, 255)
codes = np.concatenate([base, jit, np.load('hlg_safari.npy').reshape(-1,3)*0 + np.stack(np.meshgrid(*[np.round(np.arange(N)*255/16)]*3, indexing='ij'),-1).reshape(-1,3)[:, ::-1]])
ps, pk = apply_lut(S, codes), apply_lut(K, codes)
w = np.ones(len(codes)); 
for sm in (0.5, 5, 30):
    f = RBFInterpolator(ps / 255, pk, kernel='thin_plate_spline', smoothing=sm, neighbors=150, degree=1)
    lut = np.clip(f(grid / 255), 0, 255).reshape(N, N, N, 3)
    test_s, test_k = sv[h:], kv[h:]
    print(sm, 'held-out %.2f' % np.abs(apply_lut(lut, test_s) - test_k).mean())
    np.save(f'hlg_fix_{sm}.npy', lut)
