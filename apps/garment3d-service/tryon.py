import argparse
import hashlib
import io
import os
import threading
from collections import OrderedDict
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageOps
from scipy import ndimage
from skimage.graph import MCP_Geometric
from skimage.morphology import convex_hull_image

import human_parsing as hp
import layout
from delight import convert_to_srgb
from orient import upright_turns

OUTPUT_MAX_DIMENSION = 1280

DEBUG_DIR = os.environ.get("TRYON_DEBUG_DIR")

CONDITION_CACHE_SIZE = 32

MIN_REGION_FRACTION = 0.01

MIN_PERSON_FRACTION = 0.01

MIN_GARMENT_FRACTION = 0.03

MIN_COMPONENT_SHARE = 0.15

GEODESIC_MAX_DIMENSION = 384

UNIT_SHARE_OF_HEIGHT = 0.13

HAND_LENGTH = 0.9

FOOT_LENGTH = 0.6

ANKLE_DEPTH = 3.2

MASK_GROWTH = 0.2

CROP_MARGIN = 0.12

BLEND_FEATHER_PX = 3.0

RESTORE_MARGIN_PX = 1

GARMENT_PADDING = 0.06

SLEEVE_HANG_DEGREES = 20.0

SLEEVE_HANG_MIN_TURN = 15.0

LONG_SLEEVE_LENGTH = 0.5

SLEEVE_PIVOT = 0.15

GARMENT_EDGE_TRIM_PX = 2

SHADING_SIGMA = 0.3

SHADING_PRINT_TOLERANCE = 0.5

SHADING_REFERENCE_PERCENTILE = 85

SHADING_STRENGTH = 0.9

SHADING_GAIN_RANGE = (0.55, 1.15)

LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)

COLOUR_MATCH_MAX_SHIFT = 60.0

COLOUR_MATCH_LIGHTNESS = 0.5

SCENE_WHITE_PERCENTILE = 95

HEM_SHADOW_DEPTH = 0.1

HEM_SHADOW_STRENGTH = 0.35

PRINT_DISTANCE = 25.0

PRINT_LIGHTNESS_WEIGHT = 0.3

PRINT_SHARE_RANGE = (0.002, 0.4)

PRINT_COMPONENT_SHARE = 0.25

PRINT_MARGIN = 0.1

PRINT_SEARCH_MARGIN = 0.4

PRINT_ALIGN_BLUR = 0.03

PRINT_MIN_OVERLAP = 0.6

PRINT_MAX_ANISOTROPY = 1.5

PRINT_SPILL = 0.15

PRINT_COLOUR_RANGE = (0.75, 1.33)

PRINT_REGIONS = ("upper", "full")

GARMENTS = (hp.UPPER_CLOTHES, hp.SKIRT, hp.PANTS, hp.DRESS, hp.BELT, hp.SCARF)

BODY = (hp.FACE, hp.HAIR, *hp.ARMS, *hp.LEGS)

ALWAYS_KEPT = (hp.FACE, hp.HAIR, hp.HAT, hp.SUNGLASSES, hp.BAG, *hp.SHOES)

ARM_ANCHORS = (hp.UPPER_CLOTHES, hp.DRESS, hp.SCARF)

LEG_ANCHORS = (hp.PANTS, hp.SKIRT, hp.DRESS, hp.BELT)

REGION_GARMENTS = {
    "upper": (hp.UPPER_CLOTHES, hp.SCARF),
    "lower": (hp.PANTS, hp.SKIRT, hp.BELT),
    "full": (hp.DRESS, hp.UPPER_CLOTHES, hp.SKIRT, hp.PANTS),
}

PASS_ORDER = {"full": 0, "lower": 1, "upper": 2}


@dataclass(frozen=True)
class Coverage:
    region: str
    replaces: tuple[int, ...]
    keeps: tuple[int, ...]
    arm_reach: float
    leg_reach: float
    model: str | None = None


TOP_REPLACES = (hp.UPPER_CLOTHES, hp.SCARF)

TOP_KEEPS = (hp.PANTS, hp.SKIRT, hp.BELT)

BOTTOM_REPLACES = (hp.PANTS, hp.SKIRT, hp.BELT)

BOTTOM_KEEPS = (hp.UPPER_CLOTHES, hp.SCARF)

COVERAGE = {
    "T_SHIRT": Coverage("upper", TOP_REPLACES, TOP_KEEPS, arm_reach=0.45, leg_reach=0.0),
    "LONG_SLEEVE": Coverage(
        "upper", TOP_REPLACES, TOP_KEEPS, arm_reach=np.inf, leg_reach=0.0, model="upper_long"
    ),
    "HOODIE": Coverage(
        "upper", TOP_REPLACES, TOP_KEEPS, arm_reach=np.inf, leg_reach=0.0, model="upper_long"
    ),
    "SHORTS": Coverage("lower", BOTTOM_REPLACES, BOTTOM_KEEPS, arm_reach=0.0, leg_reach=0.8),
    "PANTS": Coverage("lower", BOTTOM_REPLACES, BOTTOM_KEEPS, arm_reach=0.0, leg_reach=np.inf),
    "DRESS": Coverage("full", GARMENTS, (), arm_reach=0.45, leg_reach=2.0),
}

@dataclass(frozen=True)
class GarmentPrint:
    rgb: np.ndarray
    mask: np.ndarray
    ink: np.ndarray
    fabric: np.ndarray


_CONDITION_CACHE: OrderedDict[str, tuple[Image.Image, GarmentPrint | None, np.ndarray]] = OrderedDict()

_TRY_ON_LOCK = threading.Lock()


def coverage_for(product_type: str) -> Coverage:
    coverage = COVERAGE.get(product_type)
    if coverage is None:
        raise ValueError(f"Try-on does not support {product_type} yet")
    return coverage


def region_for_product_type(product_type: str) -> str:
    return coverage_for(product_type).region


def load_photo(data: bytes, max_dimension: int = OUTPUT_MAX_DIMENSION) -> Image.Image:
    try:
        im = Image.open(io.BytesIO(data))
        icc_profile = im.info.get("icc_profile")
        im = convert_to_srgb(ImageOps.exif_transpose(im).convert("RGB"), icc_profile)
    except Exception as error:
        raise ValueError("Could not read the photo, send a JPEG, PNG or WebP image") from error
    if max(im.size) > max_dimension:
        im.thumbnail((max_dimension, max_dimension), Image.LANCZOS)
    return im


def keep_large_components(mask: np.ndarray) -> np.ndarray:
    components, count = ndimage.label(mask)
    if count <= 1:
        return mask
    areas = np.bincount(components.ravel())
    areas[0] = 0
    return np.isin(components, np.flatnonzero(areas >= MIN_COMPONENT_SHARE * areas.max()))


def body_unit(labels: np.ndarray) -> float:
    face_rows = np.flatnonzero((labels == hp.FACE).any(axis=1))
    if face_rows.size >= 8:
        return float(face_rows[-1] - face_rows[0] + 1)
    person_rows = np.flatnonzero((labels != hp.BACKGROUND).any(axis=1))
    if person_rows.size == 0:
        return 0.1 * labels.shape[0]
    return UNIT_SHARE_OF_HEIGHT * (person_rows[-1] - person_rows[0] + 1)


def resize_nearest(array: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    return cv2.resize(array, (shape[1], shape[0]), interpolation=cv2.INTER_NEAREST)


def geodesic_distance(domain: np.ndarray, anchor: np.ndarray) -> np.ndarray:
    scale = min(1.0, GEODESIC_MAX_DIMENSION / max(domain.shape))
    small_shape = (max(int(domain.shape[0] * scale), 1), max(int(domain.shape[1] * scale), 1))
    small_domain = resize_nearest(domain.astype(np.uint8), small_shape).astype(bool)
    small_anchor = resize_nearest(anchor.astype(np.uint8), small_shape).astype(bool)
    starts = np.argwhere(ndimage.binary_dilation(small_anchor, iterations=2) & small_domain)
    if len(starts) == 0:
        return np.full(domain.shape, np.inf)
    distance, _ = MCP_Geometric(np.where(small_domain, 1.0, np.inf)).find_costs(starts)
    return resize_nearest((distance / scale).astype(np.float32), domain.shape)


def touches_border(mask: np.ndarray, margin: int = 2) -> bool:
    return bool(
        mask[:margin].any() or mask[-margin:].any() or mask[:, :margin].any() or mask[:, -margin:].any()
    )


def limb_cover(
    labels: np.ndarray,
    limbs: tuple[int, ...],
    anchors: tuple[int, ...],
    reach: float,
    tip: float,
    unit: float,
    frame_margin: float = 0.0,
    worn_on: tuple[int, ...] = (),
    tip_row: float = 0.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    limb = np.isin(labels, limbs)
    none = np.zeros_like(limb)
    if reach <= 0 or not limb.any():
        return none, limb, none

    distance = geodesic_distance(limb, np.isin(labels, anchors))
    tips = none.copy()
    cut = none.copy()
    worn = ndimage.binary_dilation(np.isin(labels, worn_on), iterations=3) if worn_on else none
    margin = max(2, int(round(frame_margin * unit)))
    components, count = ndimage.label(limb)
    for index in range(1, count + 1):
        part = components == index
        reachable = part & np.isfinite(distance)
        if not reachable.any():
            continue
        far = distance[reachable].max()
        end = reachable & (distance >= far - tip * unit)
        if (end & worn).any():
            continue
        if touches_border(end, margin) or np.flatnonzero(end.any(axis=1))[-1] < tip_row:
            cut |= end
        else:
            tips |= end

    cover = limb if np.isinf(reach) else limb & (distance <= reach * unit)
    cover &= ~tips
    return cover, tips | (limb & np.isfinite(distance) & ~cover), cut & cover


def waist_row(labels: np.ndarray) -> int | None:
    for garments, edge in (((hp.PANTS, hp.SKIRT, hp.BELT), 0), ((hp.UPPER_CLOTHES,), -1), ((hp.DRESS,), 0)):
        rows = np.flatnonzero(np.isin(labels, garments).any(axis=1))
        if rows.size:
            return int(rows[edge])
    return None


def run_to_bottom(cut: np.ndarray) -> np.ndarray:
    return np.maximum.accumulate(cut, axis=0)


def lower_body_hull(
    sides: list[np.ndarray], garment: np.ndarray, coverage: Coverage
) -> np.ndarray:
    if coverage.region == "full":
        body = np.logical_or.reduce(sides) | garment
        return convex_hull_image(body) if body.any() else body
    hull = np.zeros_like(garment)
    for leg in sides:
        body = leg | garment
        if body.any():
            hull |= convex_hull_image(body)
    return hull


def replaced_region(labels: np.ndarray, coverage: Coverage) -> np.ndarray:
    replaced = np.isin(labels, coverage.replaces)
    dress = labels == hp.DRESS
    if coverage.region != "full" and dress.any() and replaced.mean() < MIN_REGION_FRACTION:
        rows = np.flatnonzero(dress.any(axis=1))
        split = rows[0] + int(0.45 * (rows[-1] - rows[0] + 1))
        half = np.zeros_like(dress)
        if coverage.region == "upper":
            half[:split] = True
        else:
            half[split:] = True
        replaced |= dress & half
    return replaced


def agnostic_mask(labels: np.ndarray, coverage: Coverage) -> tuple[np.ndarray, np.ndarray]:
    if np.isin(labels, BODY).mean() < MIN_PERSON_FRACTION:
        raise ValueError(
            "Could not find a person in the photo. Face the camera in good light, "
            "with the part of your body this garment covers fully in frame"
        )
    unit = body_unit(labels)
    replaced = replaced_region(labels, coverage)

    arms, arms_kept, _ = limb_cover(
        labels, hp.ARMS, ARM_ANCHORS, coverage.arm_reach, HAND_LENGTH, unit
    )
    waist = waist_row(labels)
    legs, legs_kept, legs_cut = limb_cover(
        labels,
        hp.LEGS,
        LEG_ANCHORS,
        coverage.leg_reach,
        FOOT_LENGTH,
        unit,
        frame_margin=FOOT_LENGTH,
        worn_on=hp.SHOES,
        tip_row=0.0 if waist is None else waist + ANKLE_DEPTH * unit,
    )
    sides = [(legs & (labels == side)) | run_to_bottom(legs_cut & (labels == side)) for side in hp.LEGS]
    legs = np.logical_or.reduce(sides)
    core = replaced | arms | legs
    if coverage.leg_reach > 0:
        core |= lower_body_hull(sides, replaced & np.isin(labels, LEG_ANCHORS), coverage)
    if core.mean() < MIN_REGION_FRACTION:
        raise ValueError(
            "Could not find the part of your body this garment covers. Face the camera in "
            "good light with it fully in frame"
        )

    kept = np.isin(labels, ALWAYS_KEPT + coverage.keeps) | arms_kept | legs_kept
    grown = ndimage.distance_transform_edt(~core) <= MASK_GROWTH * unit
    mask = keep_large_components(ndimage.binary_fill_holes(grown) & ~kept)
    return mask, (arms | legs) & mask


def garment_cutout(
    im: Image.Image, region: str, turn_upright: bool = True
) -> tuple[np.ndarray, np.ndarray]:
    labels = hp.parse(im)
    garments = np.isin(labels, GARMENTS)
    worn = np.isin(labels, BODY).mean() >= MIN_PERSON_FRACTION
    mask = np.isin(labels, REGION_GARMENTS[region]) if worn else garments
    if mask.mean() < MIN_GARMENT_FRACTION:
        mask = garments
    mask = ndimage.binary_fill_holes(keep_large_components(mask))
    if turn_upright and not worn and mask.any():
        turns = upright_turns(mask, "PANTS" if region == "lower" else None)
        if turns:
            return garment_cutout(im.rotate(90 * turns, expand=True), region, turn_upright=False)
    mask = ndimage.binary_erosion(mask, iterations=GARMENT_EDGE_TRIM_PX)
    if mask.mean() < MIN_REGION_FRACTION:
        raise ValueError("Could not find the garment in the product photo")

    rgb = np.asarray(im).astype(np.float32)
    rows = np.flatnonzero(mask.any(axis=1))
    cols = np.flatnonzero(mask.any(axis=0))
    rgb = rgb[rows[0] : rows[-1] + 1, cols[0] : cols[-1] + 1]
    mask = mask[rows[0] : rows[-1] + 1, cols[0] : cols[-1] + 1]
    return fill_background(rgb, mask), mask


def fill_background(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    _, (iy, ix) = ndimage.distance_transform_edt(~mask, return_indices=True)
    return rgb[iy, ix]


def _rotate_about(points: np.ndarray, pivot: np.ndarray, angle: float) -> np.ndarray:
    c, s = np.cos(angle), np.sin(angle)
    d = points - pivot
    return pivot + np.stack([d[:, 0] * c - d[:, 1] * s, d[:, 0] * s + d[:, 1] * c], axis=1)


def hang_sleeves(rgb: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    parts = layout.detect(mask)
    if parts is None or not parts.sleeves:
        return rgb, mask
    height, width = mask.shape
    moves = []
    for side, sleeve in parts.sleeves.items():
        if sleeve.t1 - sleeve.t0 < LONG_SLEEVE_LENGTH * (parts.hem - parts.top):
            continue
        outward = -1.0 if side == "left" else 1.0
        target = np.radians(SLEEVE_HANG_DEGREES) * outward
        turn = target - np.arctan2(sleeve.along[1], sleeve.along[0])
        turn = (turn + np.pi) % (2 * np.pi) - np.pi
        if abs(np.degrees(turn)) < SLEEVE_HANG_MIN_TURN:
            continue
        row = parts.top + SLEEVE_PIVOT * (parts.armpit - parts.top)
        edge = parts.torso_lo if side == "left" else parts.torso_hi
        pivot = np.array([row, np.interp(row, np.arange(height), edge)])
        moves.append((parts.labels == layout.SLEEVE_LABELS[side], pivot, turn))
    if not moves:
        return rgb, mask

    body = mask.copy()
    for region, _, _ in moves:
        body &= ~region
    points = [np.argwhere(body)]
    for region, pivot, turn in moves:
        points.append(_rotate_about(np.argwhere(region).astype(np.float64), pivot, turn))
    everything = np.concatenate(points)
    low = np.floor(everything.min(axis=0)).astype(int) - 2
    high = np.ceil(everything.max(axis=0)).astype(int) + 3
    shape = tuple(high - low)
    out_rgb = np.zeros(shape + (3,), np.float32)
    out_mask = np.zeros(shape, bool)

    grid = np.indices(shape).reshape(2, -1).T.astype(np.float64) + low
    for region, pivot, turn in moves:
        source = _rotate_about(grid, pivot, -turn).T
        inside = ndimage.map_coordinates(region.astype(np.float32), source, order=1, cval=0.0) > 0.5
        placed = inside.reshape(shape)
        colour = np.stack(
            [ndimage.map_coordinates(rgb[:, :, c], source[:, inside], order=1, mode="nearest") for c in range(3)],
            axis=1,
        )
        out_rgb[placed] = colour
        out_mask |= placed

    rows, cols = np.nonzero(body)
    out_rgb[rows - low[0], cols - low[1]] = rgb[rows, cols]
    out_mask[rows - low[0], cols - low[1]] = True
    closed = ndimage.binary_fill_holes(ndimage.binary_closing(out_mask, iterations=3))
    return fill_background(out_rgb, out_mask), closed


def crop_box(mask: np.ndarray, aspect: float) -> tuple[int, int, int, int]:
    rows = np.flatnonzero(mask.any(axis=1))
    cols = np.flatnonzero(mask.any(axis=0))
    height = (rows[-1] - rows[0] + 1) * (1.0 + 2 * CROP_MARGIN)
    width = (cols[-1] - cols[0] + 1) * (1.0 + 2 * CROP_MARGIN)
    if width / height < aspect:
        width = height * aspect
    else:
        height = width / aspect
    height, width = int(round(height)), int(round(width))
    top = int(round((rows[0] + rows[-1]) / 2 - height / 2))
    left = int(round((cols[0] + cols[-1]) / 2 - width / 2))
    if rows[-1] == mask.shape[0] - 1:
        top = min(top, mask.shape[0] - height)
    if rows[0] == 0:
        top = max(top, 0)
    if cols[-1] == mask.shape[1] - 1:
        left = min(left, mask.shape[1] - width)
    if cols[0] == 0:
        left = max(left, 0)
    return top, left, height, width


def crop_padded(array: np.ndarray, box: tuple[int, int, int, int], mode: str) -> np.ndarray:
    top, left, height, width = box
    pad_top = max(-top, 0)
    pad_left = max(-left, 0)
    pad_bottom = max(top + height - array.shape[0], 0)
    pad_right = max(left + width - array.shape[1], 0)
    padding = [(pad_top, pad_bottom), (pad_left, pad_right)] + [(0, 0)] * (array.ndim - 2)
    padded = np.pad(array, padding, mode=mode)
    return padded[top + pad_top : top + pad_top + height, left + pad_left : left + pad_left + width]


def paste_back(
    person: np.ndarray, generated: np.ndarray, mask: np.ndarray, box: tuple[int, int, int, int]
) -> np.ndarray:
    top, left, height, width = box
    alpha = ndimage.gaussian_filter(mask.astype(np.float32), BLEND_FEATHER_PX)
    alpha = np.maximum(alpha, mask)[:, :, None]

    y0, x0 = max(top, 0), max(left, 0)
    y1 = min(top + height, person.shape[0])
    x1 = min(left + width, person.shape[1])
    out = person.copy()
    region = out[y0:y1, x0:x1]
    patch = generated[y0 - top : y1 - top, x0 - left : x1 - left]
    weight = alpha[y0 - top : y1 - top, x0 - left : x1 - left]
    out[y0:y1, x0:x1] = region * (1.0 - weight) + patch * weight
    return out


def cached_garment_condition(
    garment_bytes: bytes, region: str, size: tuple[int, int]
) -> tuple[Image.Image, GarmentPrint | None, np.ndarray]:
    key = f"{hashlib.sha256(garment_bytes).hexdigest()}:{region}:{size[0]}x{size[1]}"
    cached = _CONDITION_CACHE.get(key)
    if cached is not None:
        _CONDITION_CACHE.move_to_end(key)
        return cached
    rgb, mask = garment_cutout(load_photo(garment_bytes), region)
    shown = hang_sleeves(rgb, mask) if region == "upper" else (rgb, mask)
    prepared = (
        garment_condition(*shown, size),
        garment_print(rgb, mask) if region in PRINT_REGIONS else None,
        garment_fabric(rgb, mask),
    )
    _CONDITION_CACHE[key] = prepared
    while len(_CONDITION_CACHE) > CONDITION_CACHE_SIZE:
        _CONDITION_CACHE.popitem(last=False)
    return prepared


def garment_condition(rgb: np.ndarray, mask: np.ndarray, size: tuple[int, int]) -> Image.Image:
    alpha = mask.astype(np.float32)[:, :, None]
    on_white = rgb * alpha + 255.0 * (1.0 - alpha)
    cutout = Image.fromarray(np.clip(on_white, 0, 255).astype(np.uint8))

    width, height = size
    inner = (int(width * (1 - 2 * GARMENT_PADDING)), int(height * (1 - 2 * GARMENT_PADDING)))
    cutout.thumbnail(inner, Image.LANCZOS)
    canvas = Image.new("RGB", size, (255, 255, 255))
    canvas.paste(cutout, ((width - cutout.width) // 2, (height - cutout.height) // 2))
    return canvas


def _debug(stage: str, image) -> None:
    if not DEBUG_DIR:
        return
    os.makedirs(DEBUG_DIR, exist_ok=True)
    if not isinstance(image, Image.Image):
        array = np.asarray(image)
        image = Image.fromarray(
            (array * 255).astype(np.uint8) if array.dtype == bool else np.clip(array, 0, 255).astype(np.uint8)
        )
    image.save(os.path.join(DEBUG_DIR, f"{stage}.png"))


def dress(image: np.ndarray, garment_bytes: bytes, coverage: Coverage) -> np.ndarray:
    import catvton

    size = (catvton.WIDTH, catvton.HEIGHT)
    labels = hp.parse(Image.fromarray(image.astype(np.uint8)))
    mask, limbs = agnostic_mask(labels, coverage)
    box = crop_box(mask, size[0] / size[1])
    image_crop = crop_padded(image, box, "edge")
    mask_crop = crop_padded(mask, box, "edge")

    model_person = Image.fromarray(image_crop.astype(np.uint8)).resize(size, Image.LANCZOS)
    model_mask = Image.fromarray(mask_crop.astype(np.uint8) * 255).resize(size, Image.NEAREST)
    condition, garment_ink, fabric = cached_garment_condition(garment_bytes, coverage.region, size)
    _debug("1-person", model_person)
    _debug("2-mask", model_mask)
    _debug("3-garment", condition)

    generated = catvton.generate(model_person, condition, model_mask, coverage.model or coverage.region)
    _debug("4-generated", generated)
    generated = np.asarray(generated.resize((box[3], box[2]), Image.LANCZOS)).astype(np.float32)
    dressed = paste_back(image, generated, mask_crop, box)
    _debug("5-pasted", dressed)

    after = hp.parse(Image.fromarray(np.clip(dressed, 0, 255).astype(np.uint8)))
    dressed = fill_spare_background(image, dressed, labels, after, mask & ~limbs)
    worn = mask & np.isin(after, REGION_GARMENTS[coverage.region])
    _debug("6-worn", worn)
    if not worn.any():
        return dressed
    unit = body_unit(labels)
    dressed = match_fabric_colour(image, dressed, worn, fabric)
    _debug("7-colour", dressed)
    dressed = restore_print(dressed, worn, garment_ink, unit)
    _debug("8-print", dressed)
    dressed = transfer_shading(image, dressed, replaced_region(labels, coverage), worn, unit)
    _debug("9-shaded", dressed)
    if coverage.region == "upper":
        dressed = cast_hem_shadow(dressed, worn, np.isin(after, BOTTOM_REPLACES), unit)
    return dressed


def log_luminance(rgb: np.ndarray) -> np.ndarray:
    return np.log(rgb @ LUMA + 4.0)


def low_frequency(values: np.ndarray, support: np.ndarray, sigma: float) -> tuple[np.ndarray, np.ndarray]:
    weight = ndimage.gaussian_filter(support.astype(np.float32), sigma)
    total = ndimage.gaussian_filter(np.where(support, values, 0.0).astype(np.float32), sigma)
    return total / np.maximum(weight, 1e-6), weight


def garment_shading(rgb: np.ndarray, region: np.ndarray, sigma: float) -> np.ndarray | None:
    if region.sum() < 64:
        return None
    lum = log_luminance(rgb)
    plain = region & (np.abs(lum - np.median(lum[region])) < SHADING_PRINT_TOLERANCE)
    if plain.sum() < 64:
        return None
    shading, weight = low_frequency(lum, plain, sigma)
    known = weight > 0.05
    _, (iy, ix) = ndimage.distance_transform_edt(~known, return_indices=True)
    shading = shading[iy, ix]
    return shading - np.percentile(shading[region], SHADING_REFERENCE_PERCENTILE)


def transfer_shading(
    image: np.ndarray, dressed: np.ndarray, old: np.ndarray, worn: np.ndarray, unit: float
) -> np.ndarray:
    sigma = SHADING_SIGMA * unit
    scene = garment_shading(image, old, sigma)
    painted = garment_shading(dressed, worn, sigma)
    if scene is None or painted is None:
        return dressed
    low, high = np.log(SHADING_GAIN_RANGE)
    gain = np.exp(np.clip(SHADING_STRENGTH * (scene - painted), low, high))
    alpha = ndimage.gaussian_filter(worn.astype(np.float32), 1.5)
    gain = 1.0 + alpha * (gain - 1.0)
    return dressed * gain[:, :, None]


def weighted_lab(rgb: np.ndarray) -> np.ndarray:
    lab = cv2.cvtColor(np.clip(rgb, 0, 255).astype(np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32)
    lab[..., 0] *= PRINT_LIGHTNESS_WEIGHT
    return lab


def ink_candidates(lab: np.ndarray, region: np.ndarray, fabric: np.ndarray) -> np.ndarray:
    far = region & (np.linalg.norm(lab - fabric, axis=2) > PRINT_DISTANCE)
    return ndimage.binary_opening(far, iterations=1)


def main_components(mask: np.ndarray, min_pixels: float) -> np.ndarray:
    components, count = ndimage.label(mask)
    if count == 0:
        return mask
    areas = np.bincount(components.ravel())
    areas[0] = 0
    keep = (areas >= PRINT_COMPONENT_SHARE * areas.max()) & (areas >= min_pixels)
    return ndimage.binary_fill_holes(np.isin(components, np.flatnonzero(keep)))


def garment_fabric(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    lab = weighted_lab(rgb)
    candidates = ink_candidates(lab, mask, np.median(lab[mask], axis=0))
    plain = mask & ~ndimage.binary_dilation(candidates, iterations=3)
    return np.median(rgb[plain if plain.sum() >= 64 else mask], axis=0)


def _to_lab(rgb: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(np.clip(rgb / 255.0, 0.0, 1.0).astype(np.float32), cv2.COLOR_RGB2LAB)


def match_fabric_colour(
    image: np.ndarray, dressed: np.ndarray, worn: np.ndarray, fabric: np.ndarray
) -> np.ndarray:
    if worn.sum() < 64:
        return dressed
    lab = _to_lab(dressed)
    painted = np.median(lab[worn], axis=0)
    target = _to_lab(np.asarray(fabric, np.float32)[None, None])[0, 0]
    ceiling = float(np.percentile(_to_lab(image)[..., 0], SCENE_WHITE_PERCENTILE))
    target[0] = min(target[0], ceiling)
    shift = (target - painted) * np.array([COLOUR_MATCH_LIGHTNESS, 1.0, 1.0], np.float32)
    shift = np.clip(shift, -COLOUR_MATCH_MAX_SHIFT, COLOUR_MATCH_MAX_SHIFT)
    alpha = ndimage.gaussian_filter(worn.astype(np.float32), 1.5)[:, :, None]
    moved = cv2.cvtColor((lab + alpha * shift).astype(np.float32), cv2.COLOR_LAB2RGB) * 255.0
    return np.clip(moved, 0.0, 255.0)


def garment_print(rgb: np.ndarray, mask: np.ndarray) -> GarmentPrint | None:
    lab = weighted_lab(rgb)
    candidates = ink_candidates(lab, mask, np.median(lab[mask], axis=0))
    ink = main_components(candidates, PRINT_SHARE_RANGE[0] * mask.sum())
    low, high = PRINT_SHARE_RANGE
    if not low <= ink.sum() / mask.sum() <= high:
        return None
    fabric = garment_fabric(rgb, mask)
    rows = np.flatnonzero(ink.any(axis=1))
    cols = np.flatnonzero(ink.any(axis=0))
    pad = int(PRINT_MARGIN * max(rows[-1] - rows[0], cols[-1] - cols[0])) + 4
    top, bottom = max(rows[0] - pad, 0), min(rows[-1] + pad + 1, mask.shape[0])
    left, right = max(cols[0] - pad, 0), min(cols[-1] + pad + 1, mask.shape[1])
    return GarmentPrint(
        rgb=rgb[top:bottom, left:right].astype(np.float32),
        mask=ink[top:bottom, left:right],
        ink=np.median(lab[ink], axis=0),
        fabric=fabric,
    )


def painted_print(dressed: np.ndarray, worn: np.ndarray, garment_ink: GarmentPrint) -> np.ndarray:
    lab = weighted_lab(dressed)
    fabric = np.median(lab[worn], axis=0)
    components, count = ndimage.label(ink_candidates(lab, worn, fabric))
    inked = np.zeros_like(worn)
    for index, part in enumerate(ndimage.find_objects(components), start=1):
        component = components[part] == index
        colour = np.median(lab[part][component], axis=0)
        if np.linalg.norm(colour - garment_ink.ink) < np.linalg.norm(colour - fabric):
            inked[part] |= component
    return main_components(inked, PRINT_SHARE_RANGE[0] * worn.sum())


def restore_print(
    dressed: np.ndarray, worn: np.ndarray, garment_ink: GarmentPrint | None, unit: float
) -> np.ndarray:
    if garment_ink is None:
        return dressed
    painted = painted_print(dressed, worn, garment_ink)
    if not painted.any():
        return dressed

    rows = np.flatnonzero(painted.any(axis=1))
    cols = np.flatnonzero(painted.any(axis=0))
    extent = max(rows[-1] - rows[0], cols[-1] - cols[0]) + 1
    pad = int(PRINT_SEARCH_MARGIN * extent)
    top, bottom = max(rows[0] - pad, 0), min(rows[-1] + pad + 1, worn.shape[0])
    left, right = max(cols[0] - pad, 0), min(cols[-1] + pad + 1, worn.shape[1])
    target = painted[top:bottom, left:right]
    garment = worn[top:bottom, left:right]

    scale = np.sqrt(target.sum() / garment_ink.mask.sum())
    (ty, tx), (sy, sx) = ndimage.center_of_mass(target), ndimage.center_of_mass(garment_ink.mask)
    warp = np.array([[1 / scale, 0, sx - tx / scale], [0, 1 / scale, sy - ty / scale]], np.float32)
    blur = max(1.5, PRINT_ALIGN_BLUR * extent)
    try:
        _, warp = cv2.findTransformECC(
            cv2.GaussianBlur(target.astype(np.float32), (0, 0), blur),
            cv2.GaussianBlur(garment_ink.mask.astype(np.float32), (0, 0), blur / scale),
            warp,
            cv2.MOTION_AFFINE,
            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6),
            None,
            1,
        )
    except cv2.error:
        return dressed
    stretch = np.linalg.svd(warp[:, :2], compute_uv=False)
    if stretch[0] / stretch[1] > PRINT_MAX_ANISOTROPY:
        return dressed

    source_rgb, source_mask = garment_ink.rgb, garment_ink.mask.astype(np.float32)
    if scale < 1:
        source_rgb = cv2.GaussianBlur(source_rgb, (0, 0), 0.5 / scale)
        source_mask = cv2.GaussianBlur(source_mask, (0, 0), 0.5 / scale)
    size = (right - left, bottom - top)
    flags = cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP
    alpha = cv2.warpAffine(source_mask, warp, size, flags=flags)
    placed = (alpha > 0.5) & garment
    if (placed & target).sum() / max((placed | target).sum(), 1) < PRINT_MIN_OVERLAP:
        return dressed
    rgb = cv2.warpAffine(source_rgb, warp, size, flags=flags, borderMode=cv2.BORDER_REPLICATE)

    plain = worn & ~ndimage.binary_dilation(painted, iterations=3)
    shading = garment_shading(dressed, plain, SHADING_SIGMA * unit)
    if shading is None:
        return dressed
    light = np.exp(shading)[:, :, None]
    fabric = np.median(dressed[plain] / light[plain], axis=0)
    colour = np.clip(fabric / np.maximum(garment_ink.fabric, 1.0), *PRINT_COLOUR_RANGE)

    spill = target & ndimage.binary_dilation(placed, iterations=max(int(PRINT_SPILL * extent), 1))
    covered = ndimage.binary_dilation((alpha > 0.02) | spill, iterations=2) & garment
    hole = ndimage.binary_dilation(covered | target, iterations=3)
    crop = np.clip(dressed[top:bottom, left:right], 0, 255).astype(np.uint8)
    cloth = cv2.inpaint(crop, hole.astype(np.uint8), 5, cv2.INPAINT_TELEA).astype(np.float32)
    alpha = np.clip(alpha, 0.0, 1.0)[:, :, None]
    patch = cloth * (1.0 - alpha) + rgb * colour * light[top:bottom, left:right] * alpha
    blend = (ndimage.gaussian_filter(covered.astype(np.float32), 1.5) * garment)[:, :, None]
    out = dressed.copy()
    out[top:bottom, left:right] = dressed[top:bottom, left:right] * (1.0 - blend) + patch * blend
    return out


def cast_hem_shadow(
    dressed: np.ndarray, worn: np.ndarray, below: np.ndarray, unit: float
) -> np.ndarray:
    below &= ~worn
    if not below.any():
        return dressed
    distance = ndimage.distance_transform_edt(~worn)
    shade = HEM_SHADOW_STRENGTH * np.exp(-distance / (HEM_SHADOW_DEPTH * unit))
    shade = ndimage.gaussian_filter(np.where(below, shade, 0.0), 1.0)
    return dressed * (1.0 - shade)[:, :, None]


def fill_spare_background(
    image: np.ndarray, dressed: np.ndarray, labels: np.ndarray, after: np.ndarray, mask: np.ndarray
) -> np.ndarray:
    used = ndimage.binary_dilation(np.isin(after, GARMENTS + BODY), iterations=RESTORE_MARGIN_PX)
    spare = ndimage.binary_opening(mask & ~used, iterations=2)
    if not spare.any():
        return dressed
    was_background = spare & (labels == hp.BACKGROUND)
    out = dressed.copy()
    out[was_background] = image[was_background]
    invented = spare & ~was_background
    if invented.any():
        filled = cv2.inpaint(
            np.clip(out, 0, 255).astype(np.uint8), invented.astype(np.uint8), 5, cv2.INPAINT_TELEA
        )
        out[invented] = filled[invented]
    alpha = ndimage.gaussian_filter(spare.astype(np.float32), 1.0)[:, :, None]
    return dressed * (1.0 - alpha) + out * alpha


def try_on(person_bytes: bytes, garments: list[tuple[bytes, str]]) -> bytes:
    passes = sorted(
        ((garment_bytes, coverage_for(product_type)) for garment_bytes, product_type in garments),
        key=lambda item: PASS_ORDER[item[1].region],
    )
    if not passes:
        raise ValueError("Send at least one garment to try on")
    with _TRY_ON_LOCK:
        image = np.asarray(load_photo(person_bytes)).astype(np.float32)
        for garment_bytes, coverage in passes:
            image = dress(image, garment_bytes, coverage)

    out = Image.fromarray(np.clip(image, 0, 255).astype(np.uint8))
    buffer = io.BytesIO()
    out.save(buffer, format="JPEG", quality=92)
    return buffer.getvalue()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("person")
    parser.add_argument("out")
    parser.add_argument(
        "garments", nargs="+", metavar="PHOTO:PRODUCT_TYPE", help="e.g. tee.jpg:T_SHIRT jeans.jpg:PANTS"
    )
    args = parser.parse_args()
    garments = []
    for spec in args.garments:
        path, _, product_type = spec.rpartition(":")
        with open(path, "rb") as garment:
            garments.append((garment.read(), product_type))
    with open(args.person, "rb") as person:
        result = try_on(person.read(), garments)
    with open(args.out, "wb") as out:
        out.write(result)


if __name__ == "__main__":
    main()
