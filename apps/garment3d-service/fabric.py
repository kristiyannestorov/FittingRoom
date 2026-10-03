from dataclasses import dataclass

import numpy as np
from scipy import ndimage

LUMA = np.array([0.299, 0.587, 0.114], np.float32)

MIN_CLOTH_SHARE = 0.6

PRINT_ANGLE = 10.0

CLOTH_CURVE_ANGLE = 10.0

CLOTH_CURVE_BINS = 16
CLOTH_CURVE_MIN_PIXELS = 200

COLOUR_TRUST_LUMA = 60.0

PRINT_CONTRAST = 0.8

LOCAL_CLOTH_RADIUS = 0.06

PRINT_MIN_AREA = 0.0002

PRINT_GROW_PX = 1
PRINT_SOFTEN_PX = 0.8

DETAIL_RADIUS = 0.004

DETAIL_LIMIT = 0.1

DETAIL_DENOISE_PX = 0.7

DETAIL_CORE = 1.5


@dataclass
class ViewLayers:
    ink: np.ndarray
    detail: np.ndarray


@dataclass
class Cloth:
    colour: np.ndarray
    views: dict[str, ViewLayers]


def to_linear(srgb: np.ndarray) -> np.ndarray:
    c = np.clip(np.asarray(srgb, np.float32) / 255.0, 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(linear: np.ndarray) -> np.ndarray:
    c = np.clip(np.asarray(linear, np.float32), 0.0, 1.0)
    return 255.0 * np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def _normalized_blur(values: np.ndarray, weights: np.ndarray, sigma: float) -> np.ndarray:
    num = ndimage.gaussian_filter(values * weights, sigma)
    den = ndimage.gaussian_filter(weights, sigma)
    return num / np.maximum(den, 1e-6)


def _unit(rgb: np.ndarray) -> np.ndarray:
    return rgb / np.maximum(np.linalg.norm(rgb, axis=-1, keepdims=True), 1e-6)


def _angle(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return np.degrees(np.arccos(np.clip((a * b).sum(axis=-1), -1.0, 1.0)))


def _cloth_curve(unit: np.ndarray, log_luma: np.ndarray, plain: np.ndarray) -> np.ndarray:
    lit = plain & (log_luma >= np.median(log_luma[plain]))
    overall = _unit(np.median(unit[lit if lit.sum() >= 64 else plain], axis=0))
    core = plain & (_angle(unit, overall) < CLOTH_CURVE_ANGLE)
    if core.sum() < CLOTH_CURVE_MIN_PIXELS:
        return np.broadcast_to(overall, unit.shape)

    levels = log_luma[core]
    edges = np.linspace(*np.percentile(levels, (1, 99)), CLOTH_CURVE_BINS + 1)
    centres = (edges[:-1] + edges[1:]) / 2
    which = np.clip(np.digitize(levels, edges) - 1, 0, CLOTH_CURVE_BINS - 1)
    directions = np.full((CLOTH_CURVE_BINS, 3), np.nan)
    for i in range(CLOTH_CURVE_BINS):
        members = which == i
        if members.sum() >= CLOTH_CURVE_MIN_PIXELS:
            directions[i] = _unit(np.median(unit[core][members], axis=0))
    known = np.flatnonzero(~np.isnan(directions[:, 0]))
    if len(known) == 0:
        return np.broadcast_to(overall, unit.shape)
    expected = np.stack(
        [np.interp(log_luma, centres[known], directions[known, c]) for c in range(3)], axis=-1
    )
    return _unit(expected)


def _print_score(rgb: np.ndarray, garment: np.ndarray, plain: np.ndarray, radius: float) -> np.ndarray:
    luma = np.maximum(rgb @ LUMA, 1.0)
    log_luma = np.log(luma)
    unit = _unit(rgb)

    trust = np.clip(luma / COLOUR_TRUST_LUMA, 0.0, 1.0)
    colour_change = _angle(unit, _cloth_curve(unit, log_luma, plain)) * trust / PRINT_ANGLE

    around = _normalized_blur(log_luma, plain.astype(np.float32), radius)
    lightness_change = np.abs(log_luma - around) / PRINT_CONTRAST

    return np.where(garment, np.maximum(colour_change, lightness_change), 0.0)


def _clean_print(core: np.ndarray, garment: np.ndarray) -> np.ndarray:
    core = ndimage.binary_opening(core, np.ones((3, 3), bool))
    components, count = ndimage.label(core, np.ones((3, 3), bool))
    if count == 0:
        return core
    areas = np.bincount(components.ravel())
    areas[0] = 0
    keep = np.flatnonzero(areas >= PRINT_MIN_AREA * garment.sum())
    return np.isin(components, keep)


def analyse_view(rgb: np.ndarray, alpha: np.ndarray) -> tuple[ViewLayers, np.ndarray, float]:
    garment = alpha > 0.5
    rgb = np.asarray(rgb, np.float32)
    radius = LOCAL_CLOTH_RADIUS * max(garment.shape)

    plain = garment
    for _ in range(2):
        printed = _clean_print(_print_score(rgb, garment, plain, radius) > 1.0, garment)
        plain = garment & ~ndimage.binary_dilation(printed, iterations=2)
        if plain.sum() < 256:
            plain = garment

    ink = ndimage.binary_dilation(printed, iterations=PRINT_GROW_PX) & garment
    ink = ndimage.gaussian_filter(ink.astype(np.float32), PRINT_SOFTEN_PX) * garment

    direction = _unit(np.median(rgb[plain], axis=0))
    lightness = ndimage.gaussian_filter(rgb @ direction, DETAIL_DENOISE_PX)
    log_light = np.log(np.maximum(lightness, 1.0))
    sigma = max(DETAIL_RADIUS * max(garment.shape), 1.0)
    detail = log_light - _normalized_blur(log_light, plain.astype(np.float32), sigma)
    grain = 1.4826 * np.median(np.abs(detail[plain]))
    detail = np.sign(detail) * np.maximum(np.abs(detail) - DETAIL_CORE * grain, 0.0)
    detail = np.clip(detail, -DETAIL_LIMIT, DETAIL_LIMIT) * plain

    cloth_linear = np.median(to_linear(rgb[plain]), axis=0)
    share = float(plain.sum() / garment.sum())
    return ViewLayers(ink=ink, detail=detail.astype(np.float32)), cloth_linear, share


def analyse(cutouts: dict[str, tuple[np.ndarray, np.ndarray]]) -> Cloth | None:
    views, colours, weights = {}, [], []
    for name, (rgb, alpha) in cutouts.items():
        if (alpha > 0.5).sum() < 1024:
            continue
        layers, cloth_linear, share = analyse_view(rgb, alpha)
        print(f"{name} view: {share:.1%} plain cloth, {1 - share:.1%} print")
        if share < MIN_CLOTH_SHARE:
            print(f"The {name} view is mostly pattern, painting the photos as they are")
            return None
        views[name] = layers
        colours.append(cloth_linear)
        weights.append((alpha > 0.5).sum())
    if not views:
        return None
    colour = to_srgb(np.average(colours, axis=0, weights=weights))
    print(f"Cloth colour: sRGB {np.round(colour).astype(int).tolist()}")
    return Cloth(colour=colour, views=views)
