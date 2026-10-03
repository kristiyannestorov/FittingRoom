import argparse
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

import bake_texture
import pockets as P


def _rect(shape: tuple[int, int], cy: float, cx: float, h: float, w: float) -> np.ndarray:
    H, W = shape
    y0, y1 = int((cy - h / 2) * H), int((cy + h / 2) * H)
    x0, x1 = int((cx - w / 2) * W), int((cx + w / 2) * W)
    mask = np.zeros(shape, bool)
    mask[max(y0, 0) : y1, max(x0, 0) : x1] = True
    return mask


def add_pocket(rgb: np.ndarray, region: np.ndarray, span: float, strength: float = 1.0) -> np.ndarray:
    def scaled(gain: float) -> float:
        return float(np.exp(np.log(gain) * strength))

    gain = np.ones(rgb.shape[:2], np.float32)
    gain[region] = scaled(1.035)

    edge = ndimage.binary_dilation(region, np.ones((3, 3), bool)) ^ ndimage.binary_erosion(
        region, np.ones((3, 3), bool)
    )
    groove = ndimage.binary_dilation(
        edge, np.ones((3, 3), bool), iterations=max(int(0.0015 * span), 1)
    )
    gain[groove] = scaled(0.90)

    ys = np.where(region.any(axis=1))[0]
    lip = region.copy()
    lip[ys[0] + max(int(0.05 * len(ys)), 2) :, :] = False
    gain[lip] = scaled(0.86)

    gain = ndimage.gaussian_filter(gain, max(0.0012 * span, 1.0))
    return np.clip(rgb * gain[:, :, None], 0, 255)


def add_print(rgb: np.ndarray, region: np.ndarray, span: float) -> np.ndarray:
    out = rgb.copy()
    lum = rgb[region] @ P.__dict__.get("LUMA", np.array([0.2126, 0.7152, 0.0722], np.float32))
    tint = np.array([1.35, 0.85, 0.75], np.float32)
    tint = tint / (tint @ np.array([0.2126, 0.7152, 0.0722], np.float32))
    out[region] = np.clip(lum[:, None] * tint[None, :], 0, 255)
    edge = ndimage.binary_dilation(region, np.ones((3, 3), bool)) & ~region
    out[edge] = rgb[edge]
    return out


def add_fold(rgb: np.ndarray, alpha: np.ndarray, span: float) -> np.ndarray:
    H, W = alpha.shape
    yy, xx = np.mgrid[0:H, 0:W]
    centre = W * 0.42 + (yy - H / 2) * 0.06
    valley = np.exp(-0.5 * ((xx - centre) / (0.018 * span)) ** 2)
    gain = 1.0 - 0.22 * valley
    return np.clip(rgb * gain[:, :, None], 0, 255)


def iou(a: np.ndarray, b: np.ndarray) -> float:
    union = (a | b).sum()
    return float((a & b).sum() / union) if union else 0.0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("photo", help="a flat-lay photo of a garment with no pockets")
    ap.add_argument("--debug-prefix", help="write each case's overlay here")
    ap.add_argument(
        "--sweep", action="store_true", help="report the strength at which detection starts"
    )
    args = ap.parse_args()

    rgb, alpha = bake_texture.load_cutout(
        args.photo, bake_texture._rembg_session, delight_strength=0.0
    )
    rgb = rgb.astype(np.float32)
    span = float(max(alpha.shape))
    garment = alpha > 0.5

    region = _rect(alpha.shape, cy=0.42, cx=0.50, h=0.13, w=0.17) & garment

    cases = [
        ("PLAIN", rgb, 0, None),
        ("POCKET", add_pocket(rgb, region, span, strength=3.0), 1, region),
        ("PRINT", add_print(rgb, region, span), 0, None),
        ("FOLD", add_fold(rgb, alpha, span), 0, None),
    ]

    failures = []
    for name, image, expected, truth in cases:
        found = P.analyse(image, alpha)
        ok = len(found) == expected
        detail = ""
        if truth is not None and found:
            overlap = max(iou(p.mask, truth) for p in found)
            detail = f"  IoU {overlap:.2f}"
            if overlap < 0.5:
                ok = False
                detail += " (too far off the real one)"
        print(f"{name:<7} expected {expected}, found {len(found)}{detail}  {'ok' if ok else 'FAIL'}")
        for pocket in found:
            print(f"        {pocket}")
        if not ok:
            failures.append(name)
        if args.debug_prefix:
            path = f"{args.debug_prefix}-{name.lower()}.png"
            Image.fromarray(P.debug_overlay(image, alpha, found)).save(path)
            print(f"        wrote {path}")

    if args.sweep:
        print("\nsensitivity sweep (pocket strength -> pockets found):")
        for strength in (0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0):
            image = add_pocket(rgb, region, span, strength=strength)
            found = P.analyse(image, alpha)
            hit = max((iou(p.mask, region) for p in found), default=0.0)
            print(
                f"  x{strength:<4} {len(found)} found, best IoU {hit:.2f}"
                + (f", conf {found[0].confidence:.2f}" if found else "")
            )

    print("FAILED: " + ", ".join(failures) if failures else "All cases behaved.")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
