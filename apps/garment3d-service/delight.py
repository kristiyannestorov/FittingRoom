import io

import numpy as np
from PIL import Image, ImageCms
from scipy import ndimage

SCALES = (
    (0.16, 1.55),
    (0.045, 1.16),
    (0.015, 1.10),
)

ROBUST_SIGMA = 0.14

CHROMA_SIGMA = 0.10

ITERATIONS = 3

MASK_EROSION_FRACTION = 0.008

LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)

MIN_LUMINANCE = 4.0


SPECULAR_PERCENTILE = 99.0

MAX_WHITE_BALANCE_GAIN = 1.25

MIN_ILLUMINANT_SAMPLES = 2000

HIGHLIGHT_CLOTH_ANGLE = 15.0

CLOTH_SATURATION_RAMP = (0.3, 0.6)


def convert_to_srgb(image: Image.Image, icc_profile: bytes | None = None) -> Image.Image:
    icc_profile = icc_profile or image.info.get("icc_profile")
    if not icc_profile:
        return image
    try:
        source = ImageCms.ImageCmsProfile(io.BytesIO(icc_profile))
        return ImageCms.profileToProfile(
            image.convert("RGB"), source, ImageCms.createProfile("sRGB"), outputMode="RGB"
        )
    except (OSError, ImageCms.PyCMSError):
        return image


def _chromaticity(mean_rgb: np.ndarray) -> np.ndarray:
    m = np.maximum(np.asarray(mean_rgb, np.float32), 1e-6)
    return m / m.mean()


def neutralize_illuminant(rgb: np.ndarray, alpha: np.ndarray, strength: float = 1.0) -> np.ndarray:
    if strength <= 0:
        return rgb

    foreground = alpha > 0.9
    if foreground.sum() < MIN_ILLUMINANT_SAMPLES:
        return rgb

    cloth = np.median(rgb[foreground], axis=0)
    lo, hi = CLOTH_SATURATION_RAMP
    neutral = float(np.clip((hi - np.linalg.norm(_chromaticity(cloth) - 1.0)) / (hi - lo), 0.0, 1.0))
    if neutral <= 0.0:
        return rgb

    unit = rgb / np.maximum(np.linalg.norm(rgb, axis=2, keepdims=True), 1e-6)
    direction = cloth / max(float(np.linalg.norm(cloth)), 1e-6)
    near_cloth = np.degrees(np.arccos(np.clip(unit @ direction, -1.0, 1.0))) < HIGHLIGHT_CLOTH_ANGLE
    candidates = foreground & near_cloth
    if candidates.sum() < MIN_ILLUMINANT_SAMPLES:
        candidates = foreground

    lum = rgb @ LUMA
    highlight = candidates & (lum >= np.percentile(lum[candidates], SPECULAR_PERCENTILE))
    if highlight.sum() < 64:
        return rgb
    illuminant = _chromaticity(rgb[highlight].mean(axis=0))

    background = alpha < 0.1
    confidence = 0.0
    if background.sum() >= MIN_ILLUMINANT_SAMPLES:
        cast = illuminant - 1.0
        reference = _chromaticity(np.median(rgb[background], axis=0)) - 1.0
        scale = np.linalg.norm(cast) * np.linalg.norm(reference)
        if scale > 1e-6:
            confidence = float(np.clip(np.dot(cast, reference) / scale, 0.0, 1.0))
    confidence *= neutral
    if confidence <= 0.0:
        return rgb

    gain = 1.0 / illuminant
    gain = 1.0 + (gain - 1.0) * confidence * float(strength)
    gain = np.clip(gain, 1.0 / MAX_WHITE_BALANCE_GAIN, MAX_WHITE_BALANCE_GAIN)

    out = rgb * gain
    after = (out @ LUMA)[foreground].mean()
    if after > 1e-6:
        out = out * (lum[foreground].mean() / after)
    return np.clip(out, 0.0, 255.0)


def _box(values: np.ndarray, radius: int) -> np.ndarray:
    width = max(int(round((2 * radius + 1) / np.sqrt(3.0))), 1)
    for _ in range(3):
        values = ndimage.uniform_filter(values, size=width, mode="nearest")
    return values


def _weighted_blur(values: np.ndarray, weights: np.ndarray, radius: int) -> np.ndarray:
    num = _box(values * weights, radius)
    den = _box(weights, radius)
    return num / np.maximum(den, 1e-6)


EVIDENCE_RAMP = (0.04, 0.25)


def _shading_field(
    log_lum: np.ndarray,
    chroma: np.ndarray,
    core: np.ndarray,
    radius: int,
    prior: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    base = core.astype(np.float32)
    if prior is not None:
        base = base * prior

    chroma_local = np.stack(
        [_weighted_blur(chroma[:, :, c], base, radius) for c in range(3)], axis=2
    )
    chroma_dev = np.abs(chroma - chroma_local).max(axis=2)
    chroma_ok = np.exp(-0.5 * (chroma_dev / CHROMA_SIGMA) ** 2)

    weights = base * chroma_ok
    field = np.zeros_like(log_lum)
    cover = np.maximum(_box(core.astype(np.float32), radius), 1e-6)

    voting = core & (weights > 0.5)
    reference = float(np.median(log_lum[voting if voting.sum() >= 256 else core]))
    log_lum = log_lum - reference

    for _ in range(ITERATIONS):
        num = _box(log_lum * weights, radius)
        den = _box(weights, radius)
        lo, hi = EVIDENCE_RAMP
        trust = np.clip((den / cover - lo) / (hi - lo), 0.0, 1.0)
        trust = trust * trust * (3.0 - 2.0 * trust)
        field = num / np.maximum(den, 1e-6) * trust
        residual = log_lum - field
        weights = base * chroma_ok * np.exp(-0.5 * (residual / ROBUST_SIGMA) ** 2)

    return field - np.median(field[core]), weights


def shading_scales(rgb: np.ndarray, alpha: np.ndarray) -> list[tuple[float, np.ndarray]]:
    mask = alpha > 0.5
    if mask.sum() < 256:
        return []

    span = float(max(mask.shape))
    erosion = max(int(MASK_EROSION_FRACTION * span), 1)
    core = ndimage.binary_erosion(mask, np.ones((3, 3), bool), iterations=erosion)
    if core.sum() < 256:
        core = mask

    lum = np.clip(rgb @ LUMA, MIN_LUMINANCE, None)
    chroma = rgb / lum[:, :, None]
    log_lum = np.log(lum)

    remaining = log_lum
    fields = []
    prior = None
    for radius_fraction, max_gain in SCALES:
        radius = max(int(radius_fraction * span), 2)
        field, weights = _shading_field(remaining, chroma, core, radius, prior)
        limit = np.log(max_gain)
        field = np.clip(field, -limit, limit)
        fields.append((radius_fraction, field))
        remaining = remaining - field
        prior = weights

    return fields


def delight(rgb: np.ndarray, alpha: np.ndarray, strength: float = 1.0) -> np.ndarray:
    if strength <= 0:
        return rgb

    fields = shading_scales(rgb, alpha)
    if not fields:
        return rgb

    total = sum(field for _, field in fields)
    gain = np.exp(-total * float(strength))[:, :, None]
    return np.clip(rgb * gain, 0.0, 255.0)


def shading_preview(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    corrected = delight(rgb, alpha, strength=1.0)
    ratio = np.clip(rgb @ LUMA, MIN_LUMINANCE, None) / np.clip(
        corrected @ LUMA, MIN_LUMINANCE, None
    )
    grey = np.clip(128.0 * ratio, 0, 255)
    return np.repeat(grey[:, :, None], 3, axis=2) * (alpha > 0.5)[:, :, None]


def main() -> None:
    import argparse
    import os

    from PIL import Image

    ap = argparse.ArgumentParser(
        description="De-light a garment photo (debug/tuning entry point). Writes "
        "<name>-delit.png and <name>-shading.png next to --out."
    )
    ap.add_argument("photo")
    ap.add_argument("--out", default="delight-preview.png")
    ap.add_argument("--strength", type=float, default=1.0)
    args = ap.parse_args()

    import bake_texture

    rgb, alpha = bake_texture.load_cutout(
        args.photo, bake_texture._rembg_session, cache=True, delight_strength=0.0
    )

    stem, _ = os.path.splitext(args.out)
    Image.fromarray(
        np.clip(delight(rgb, alpha, args.strength), 0, 255).astype(np.uint8)
    ).save(f"{stem}-delit.png")
    Image.fromarray(shading_preview(rgb, alpha).astype(np.uint8)).save(
        f"{stem}-shading.png"
    )
    print(f"Wrote {stem}-delit.png and {stem}-shading.png")


if __name__ == "__main__":
    main()
