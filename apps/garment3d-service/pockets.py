import argparse
import os
from dataclasses import dataclass, field

import cv2
import numpy as np
from scipy import ndimage

from delight import LUMA, MIN_LUMINANCE, shading_scales

STRUCTURE_SCALE_MAX = 0.10

BACKGROUND_RADIUS = 0.13

MIN_INTERIOR_STEP = 0.012

MAX_INTERIOR_CHROMA = 0.045

MAX_ASPECT = 2.8

MIN_AREA_FRACTION = 0.004
MAX_AREA_FRACTION = 0.18

SEAM_WIDTH = 0.004
SEAM_LENGTH = 0.022
SEAM_ORIENTATIONS = 8

MIN_SEAM_SUPPORT = 1.15

MIN_SOLIDITY = 0.72

INTERIOR_RING = 0.012

ACCEPT_CONFIDENCE = 0.55


POCKET_HEIGHT = 0.55

SEAM_GROOVE = 0.45

OPENING_LIP = 1.35

HEIGHT_SMOOTH = 0.0035


@dataclass
class Pocket:
    mask: np.ndarray
    bbox: tuple[int, int, int, int]
    area_fraction: float
    solidity: float
    edge_completeness: float
    interior_step: float
    confidence: float
    kind: str
    scores: dict = field(default_factory=dict)

    def __str__(self) -> str:
        y0, x0, y1, x1 = self.bbox
        return (
            f"{self.kind:<5} conf {self.confidence:.2f}  "
            f"area {self.area_fraction * 100:5.2f}%  solidity {self.solidity:.2f}  "
            f"edges {self.edge_completeness:.2f}  step {self.interior_step:+.3f}  "
            f"bbox ({x0},{y0})-({x1},{y1})"
        )


def _line_kernel(length: int, angle: float) -> np.ndarray:
    size = length if length % 2 else length + 1
    kernel = np.zeros((size, size), np.float32)
    centre = size // 2
    dy, dx = np.sin(np.radians(angle)), np.cos(np.radians(angle))
    for t in np.linspace(-centre, centre, size * 2):
        y, x = int(round(centre + t * dy)), int(round(centre + t * dx))
        if 0 <= y < size and 0 <= x < size:
            kernel[y, x] = 1.0
    return kernel / kernel.sum()


def seam_evidence(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    fields = shading_scales(rgb, alpha)
    if not fields:
        return np.zeros(alpha.shape, np.float32)

    span = float(max(alpha.shape))
    lum = np.clip(rgb @ LUMA, MIN_LUMINANCE, None)
    residual = np.log(lum) - sum(f for _, f in fields)

    width = max(int(SEAM_WIDTH * span), 1)
    depth = np.clip(
        ndimage.grey_closing(residual, footprint=np.ones((width * 2 + 1,) * 2, bool)) - residual,
        0,
        None,
    )

    length = max(int(SEAM_LENGTH * span), 5)
    responses = [
        ndimage.convolve(depth, _line_kernel(length, 180.0 * i / SEAM_ORIENTATIONS), mode="nearest")
        for i in range(SEAM_ORIENTATIONS)
    ]
    half = SEAM_ORIENTATIONS // 2
    best = np.zeros_like(depth)
    for i, response in enumerate(responses):
        np.maximum(best, response - responses[(i + half) % SEAM_ORIENTATIONS], out=best)
    return best


def offset_map(rgb: np.ndarray, alpha: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    fields = shading_scales(rgb, alpha)
    if not fields:
        return np.zeros(alpha.shape, np.float32), np.zeros(alpha.shape, np.float32)

    span = float(max(alpha.shape))
    fine = [f for radius_fraction, f in fields if radius_fraction <= STRUCTURE_SCALE_MAX]
    structure = (
        np.sum(fine, axis=0).astype(np.float32)
        if fine
        else np.zeros(alpha.shape, np.float32)
    )

    weight = (alpha > 0.5).astype(np.float32)
    radius = max(BACKGROUND_RADIUS * span, 4.0)
    num = ndimage.gaussian_filter(structure * weight, radius)
    den = ndimage.gaussian_filter(weight, radius)
    background = num / np.maximum(den, 1e-6)
    return (structure - background).astype(np.float32), structure


def _soft(value: float, lo: float, hi: float) -> float:
    if hi <= lo:
        return 1.0 if value >= hi else 0.0
    return float(np.clip((value - lo) / (hi - lo), 0.0, 1.0))


def analyse(rgb: np.ndarray, alpha: np.ndarray) -> list[Pocket]:
    garment = alpha > 0.5
    if garment.sum() < 1024:
        return []

    span = float(max(garment.shape))
    offset, field = offset_map(rgb, alpha)

    inset = max(int(0.006 * span), 2)
    core = ndimage.binary_erosion(garment, np.ones((3, 3), bool), iterations=inset)
    if core.sum() < 1024:
        return []

    raised = (np.abs(offset) > MIN_INTERIOR_STEP * 0.6) & core

    consolidate = max(int(0.012 * span), 2)
    raised = ndimage.binary_closing(raised, np.ones((consolidate * 2 + 1,) * 2, bool))
    raised = ndimage.binary_fill_holes(raised)
    grain = max(int(0.006 * span), 1)
    raised = ndimage.binary_opening(raised, np.ones((grain * 2 + 1,) * 2, bool))

    labels, count = ndimage.label(raised)
    if count == 0:
        return []

    lum = np.clip(rgb @ LUMA, MIN_LUMINANCE, None)
    chroma = rgb / lum[:, :, None]

    seams = seam_evidence(rgb, alpha)
    seam_floor = float(np.median(seams[core])) or 1e-6

    garment_area = float(garment.sum())
    ring = max(int(INTERIOR_RING * span), 2)
    ring_kernel = np.ones((ring * 2 + 1,) * 2, bool)
    hem_band = ndimage.binary_dilation(~garment, np.ones((3, 3), bool), iterations=ring)

    pockets: list[Pocket] = []
    for label in range(1, count + 1):
        mask = labels == label
        area = float(mask.sum())
        area_fraction = area / garment_area
        if not (MIN_AREA_FRACTION <= area_fraction <= MAX_AREA_FRACTION):
            continue

        ys, xs = np.where(mask)
        bbox = (int(ys.min()), int(xs.min()), int(ys.max()), int(xs.max()))
        height, width = bbox[2] - bbox[0] + 1, bbox[3] - bbox[1] + 1
        aspect = max(height, width) / max(min(height, width), 1)
        if aspect > MAX_ASPECT:
            continue

        contours, _ = cv2.findContours(
            mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE
        )
        if not contours:
            continue
        outline = max(contours, key=cv2.contourArea)
        hull_area = cv2.contourArea(cv2.convexHull(outline))
        solidity = area / hull_area if hull_area > 0 else 0.0

        outside = ndimage.binary_dilation(mask, ring_kernel) & ~mask & core
        if outside.sum() < 64:
            continue

        interior_step = float(np.median(offset[mask]))
        chroma_shift = float(
            np.abs(np.median(chroma[mask], axis=0) - np.median(chroma[outside], axis=0)).max()
        )
        if chroma_shift > MAX_INTERIOR_CHROMA:
            continue

        border = ndimage.binary_dilation(mask, np.ones((3, 3), bool)) & ~mask
        edge_completeness = float(
            (np.abs(offset[border]) > MIN_INTERIOR_STEP * 0.5).mean() if border.any() else 0.0
        )

        seam_support = float(np.mean(seams[border])) / seam_floor if border.any() else 0.0

        scores = {
            "step": _soft(abs(interior_step), MIN_INTERIOR_STEP * 0.6, MIN_INTERIOR_STEP * 2.0),
            "seam": _soft(seam_support, MIN_SEAM_SUPPORT - 0.10, MIN_SEAM_SUPPORT + 0.15),
            "solidity": _soft(solidity, MIN_SOLIDITY - 0.12, MIN_SOLIDITY + 0.10),
            "shape": 1.0 - _soft(aspect, 1.8, MAX_ASPECT),
            "colour": 1.0 - _soft(chroma_shift, MAX_INTERIOR_CHROMA * 0.5, MAX_INTERIOR_CHROMA),
            "size": _soft(area_fraction, MIN_AREA_FRACTION * 0.8, MIN_AREA_FRACTION * 3.0)
            * (1.0 - _soft(area_fraction, MAX_AREA_FRACTION * 0.55, MAX_AREA_FRACTION)),
        }
        confidence = float(np.prod(list(scores.values())) ** (1 / len(scores)))
        if confidence < ACCEPT_CONFIDENCE:
            continue

        pockets.append(
            Pocket(
                mask=mask,
                bbox=bbox,
                area_fraction=area_fraction,
                solidity=solidity,
                edge_completeness=edge_completeness,
                interior_step=interior_step,
                confidence=confidence,
                kind="HEM" if (border & hem_band).sum() > 0.15 * border.sum() else "PATCH",
                scores=scores,
            )
        )

    return sorted(pockets, key=lambda p: p.confidence, reverse=True)


def relief_height(pockets: list[Pocket], shape: tuple[int, int]) -> np.ndarray:
    height = np.zeros(shape, np.float32)
    if not pockets:
        return height

    span = float(max(shape))
    for pocket in pockets:
        mask = pocket.mask
        boundary = ndimage.binary_dilation(mask, np.ones((3, 3), bool)) ^ ndimage.binary_erosion(
            mask, np.ones((3, 3), bool)
        )
        groove = ndimage.binary_dilation(
            boundary, np.ones((3, 3), bool), iterations=max(int(0.002 * span), 1)
        )

        patch = np.where(mask, POCKET_HEIGHT * pocket.confidence, 0.0).astype(np.float32)

        y0, _x0, y1, _x1 = pocket.bbox
        lip_depth = max(int(0.02 * (y1 - y0 + 1)), 1)
        lip = mask.copy()
        lip[y0 + lip_depth :, :] = False
        patch[lip] = POCKET_HEIGHT * OPENING_LIP * pocket.confidence

        patch[groove & ~lip] -= POCKET_HEIGHT * SEAM_GROOVE * pocket.confidence
        height += patch

    height = ndimage.gaussian_filter(height, max(HEIGHT_SMOOTH * span, 1.0))
    peak = float(np.abs(height).max())
    return height / peak if peak > 1e-6 else height


def height_to_normal(height: np.ndarray, strength: float = 1.0) -> np.ndarray:
    gy, gx = np.gradient(height.astype(np.float32))
    nx, ny, nz = -gx * strength, gy * strength, np.ones_like(height)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    rgb = np.stack([nx / norm, ny / norm, nz / norm], axis=2)
    return np.clip((rgb * 0.5 + 0.5) * 255.0, 0, 255).astype(np.uint8)


def debug_overlay(rgb: np.ndarray, alpha: np.ndarray, pockets: list[Pocket]) -> np.ndarray:
    out = np.clip(rgb, 0, 255).astype(np.uint8).copy()
    out[alpha <= 0.5] = (out[alpha <= 0.5] * 0.35).astype(np.uint8)
    for i, pocket in enumerate(pockets):
        contours, _ = cv2.findContours(
            pocket.mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        cv2.drawContours(out, contours, -1, (255, 64, 0), max(out.shape[0] // 400, 2))
        y0, x0, _y1, _x1 = pocket.bbox
        cv2.putText(
            out,
            f"{i + 1}: {pocket.kind} {pocket.confidence:.2f}",
            (x0, max(y0 - 8, 16)),
            cv2.FONT_HERSHEY_SIMPLEX,
            out.shape[0] / 1400,
            (255, 64, 0),
            max(out.shape[0] // 700, 1),
        )
    return out


def main() -> None:
    from PIL import Image

    import bake_texture

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("photo")
    ap.add_argument("--debug", help="write an outlined copy of the photo here")
    ap.add_argument("--height", help="write the relief height field here")
    ap.add_argument("--normal", help="write the relief as a normal map here")
    args = ap.parse_args()

    rgb, alpha = bake_texture.load_cutout(
        args.photo, bake_texture._rembg_session, delight_strength=0.0
    )
    pockets = analyse(rgb.astype(np.float32), alpha)

    print(f"{os.path.basename(args.photo)}: {len(pockets)} pocket(s)")
    for pocket in pockets:
        print(f"  {pocket}")

    if args.debug:
        Image.fromarray(debug_overlay(rgb, alpha, pockets)).save(args.debug)
        print(f"Wrote {args.debug}")
    if args.height or args.normal:
        height = relief_height(pockets, alpha.shape)
        if args.height:
            Image.fromarray((np.clip(height, 0, 1) * 255).astype(np.uint8)).save(args.height)
            print(f"Wrote {args.height}")
        if args.normal:
            Image.fromarray(height_to_normal(height)).save(args.normal)
            print(f"Wrote {args.normal}")


if __name__ == "__main__":
    main()
