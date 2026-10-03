import numpy as np
from scipy import ndimage

RIB_CONTRAST = 0.1
RIB_SHARPNESS = 2.0
BAND_SHADE = 0.96
BAND_EDGE_SHARE = 0.08
BAND_EDGE_DARKEN = 0.1
BAND_SEAM_AT = 1.02
BAND_SEAM_WIDTH = 0.015
BAND_SEAM_DARKEN = 0.3

CORD_SHADE = 0.9
CORD_TIP_M = 0.025
CORD_TIP_SHADE = 0.78
CORD_STITCH_M = 0.0015
EYELET_HOLE_M = 0.0025
EYELET_RING_M = 0.0045
EYELET_HOLE_SHADE = 0.35
EYELET_RING_SHADE = 0.82

SEAM_SIGMAS = (1.0, 1.5)
SEAM_RANGE = (97.0, 99.7)
SEAM_DARKEN = 0.3
SEAM_CLOTH_DISTANCE = 30.0
SEAM_CLOTH_LIGHTER = 15.0

STRINGS_SIGMAS = SEAM_SIGMAS
STRINGS_HYSTERESIS = (0.03, 0.12)
STRINGS_CLOSE = 0.012
STRINGS_WINDOW_ROWS = (0.02, 0.42)
STRINGS_WINDOW_HALF_WIDTH = 0.24
STRINGS_MIN_LENGTH = 0.07
STRINGS_GROW = 0.008
STRINGS_JOIN = 0.02


def read_attributes(glb_path: str, mesh_name: str) -> dict[str, np.ndarray]:
    from refit_garments import Glb

    glb = Glb(glb_path)
    mesh = next((m for m in glb.gltf.get("meshes", []) if m.get("name") == mesh_name), None)
    if mesh is None or len(mesh["primitives"]) != 1:
        return {}
    attributes = mesh["primitives"][0]["attributes"]
    return {
        name: glb.accessor(index).astype(np.float32).reshape(glb.accessor(index).shape[0], -1)
        for name, index in attributes.items()
        if name.startswith("_")
    }


def outside_faces(faces: np.ndarray, details: dict[str, np.ndarray]) -> np.ndarray:
    part = details.get("_PART")
    if part is None or part.shape[1] < 3:
        return faces
    return faces[part[faces, 2].max(axis=1) < 0.5]


def paint_ribs(img: np.ndarray, rib: np.ndarray, filled: np.ndarray) -> np.ndarray:
    up = rib[:, :, 0]
    in_band = filled & (up >= 0) & (up < 1.0)
    near_seam = filled & (np.abs(up - BAND_SEAM_AT) < 4 * BAND_SEAM_WIDTH)
    if not (in_band.any() or near_seam.any()):
        return img
    shade = np.ones(up.shape, np.float32)

    angle = np.arctan2(rib[:, :, 2], rib[:, :, 1])
    wave = np.cos(angle * rib[:, :, 3])
    wales = 1.0 + RIB_CONTRAST * np.tanh(RIB_SHARPNESS * wave) / np.tanh(RIB_SHARPNESS)
    edge = 1.0 - BAND_EDGE_DARKEN * np.clip(1.0 - up / BAND_EDGE_SHARE, 0.0, 1.0)
    shade[in_band] = (BAND_SHADE * wales * edge)[in_band]
    seam = 1.0 - BAND_SEAM_DARKEN * np.exp(-(((up - BAND_SEAM_AT) / BAND_SEAM_WIDTH) ** 2))
    shade[near_seam] *= seam[near_seam]
    print(f"Knitted rib into {in_band.sum()} texels of cuff and hem band")
    return img * shade[:, :, None]


def paint_cords(
    img: np.ndarray, part: np.ndarray, pos: np.ndarray, filled: np.ndarray, confidence: np.ndarray
) -> np.ndarray:
    cord = filled & (part[:, :, 0] > 0.5)
    if not cord.any():
        return img
    cloth = filled & ~cord & (confidence >= 1.0)
    colour = np.median(img[cloth if cloth.any() else filled & ~cord], axis=0)
    along = part[:, :, 1]
    length = float(along[cord].max())

    out = img.copy()
    grain = img - ndimage.uniform_filter(img, size=(5, 5, 1))
    shade = np.full(along.shape, CORD_SHADE, np.float32)
    tip = along > length - CORD_TIP_M
    shade[tip] *= CORD_TIP_SHADE / CORD_SHADE
    stitch = np.abs(along - (length - CORD_TIP_M)) < CORD_STITCH_M
    shade[stitch] *= 0.8
    out[cord] = colour * shade[cord][:, None] + 0.5 * grain[cord]

    top = cord & (along < 0.004)
    for sign in (-1.0, 1.0):
        mine = top & (np.sign(pos[:, :, 0]) == sign)
        if not mine.any():
            continue
        centre = pos[mine].mean(axis=0)
        distance = np.linalg.norm(pos - centre, axis=2)
        ring = filled & ~cord & (distance < EYELET_RING_M)
        hole = ring & (distance < EYELET_HOLE_M)
        out[ring & ~hole] *= EYELET_RING_SHADE
        out[hole] *= EYELET_HOLE_SHADE
    print(f"Painted {cord.sum()} texels of drawstring, {length * 1000:.0f} mm long, with eyelets")
    return out


def seam_ridges(rgb: np.ndarray, alpha: np.ndarray, sigmas=SEAM_SIGMAS) -> tuple[np.ndarray, np.ndarray]:
    from skimage.color import rgb2lab
    from skimage.filters import sato

    garment = ndimage.binary_erosion(alpha > 0.5, iterations=4)
    if garment.sum() < 1000:
        return np.zeros(alpha.shape, np.float32), garment
    luminance = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    ridge = sato(luminance, sigmas=sigmas, black_ridges=True, mode="reflect")
    lo, hi = np.percentile(ridge[garment], SEAM_RANGE)
    strength = np.clip((ridge - lo) / max(hi - lo, 1e-6), 0.0, 1.0) * garment
    strength *= cloth_coloured(rgb, garment)
    return strength.astype(np.float32), garment


def cloth_coloured(rgb: np.ndarray, garment: np.ndarray) -> np.ndarray:
    from skimage.color import rgb2lab

    lab = rgb2lab(np.clip(rgb / 255.0, 0.0, 1.0))
    cloth = np.median(lab[garment], axis=0)
    lightness = lab[:, :, 0] - cloth[0]
    tint = lab[:, :, 1:] / np.maximum(lab[:, :, :1], 1.0) - cloth[1:] / max(cloth[0], 1.0)
    return (lightness < SEAM_CLOTH_LIGHTER) & (np.linalg.norm(tint, axis=2) * max(cloth[0], 1.0) < SEAM_CLOTH_DISTANCE)


def drawstring_mask(rgb: np.ndarray, alpha: np.ndarray, top: float, hem: float, centre: float, width: float) -> np.ndarray:
    strength, garment = seam_ridges(rgb, alpha, STRINGS_SIGMAS)
    h, w = alpha.shape
    span = hem - top
    window = np.zeros((h, w), bool)
    r0, r1 = int(top + STRINGS_WINDOW_ROWS[0] * span), int(top + STRINGS_WINDOW_ROWS[1] * span)
    c0, c1 = int(centre - STRINGS_WINDOW_HALF_WIDTH * width), int(centre + STRINGS_WINDOW_HALF_WIDTH * width)
    window[max(r0, 0) : max(r1, 0), max(c0, 0) : max(c1, 0)] = True

    other = garment & ~cloth_coloured(rgb, garment)
    near_other = ndimage.binary_dilation(other, iterations=max(int(0.012 * width), 2))

    from skimage.filters import apply_hysteresis_threshold

    lines = apply_hysteresis_threshold(strength * (window & ~near_other), *STRINGS_HYSTERESIS)
    lines = ndimage.binary_closing(lines, iterations=max(int(STRINGS_CLOSE * width), 1))
    labels, count = ndimage.label(lines, np.ones((3, 3), bool))
    keep = np.zeros_like(lines)
    for index, box in enumerate(ndimage.find_objects(labels), start=1):
        extent = max(box[0].stop - box[0].start, box[1].stop - box[1].start)
        if extent >= STRINGS_MIN_LENGTH * width:
            keep[box] |= labels[box] == index
    if keep.any():
        faint = (strength * (window & ~near_other)) > STRINGS_HYSTERESIS[0]
        faint = ndimage.binary_closing(faint, iterations=max(int(2 * STRINGS_CLOSE * width), 1))
        reach = ndimage.binary_dilation(keep, iterations=max(int(STRINGS_JOIN * width), 1))
        labels, count = ndimage.label(faint, np.ones((3, 3), bool))
        touching = np.unique(labels[reach & faint])
        keep |= np.isin(labels, touching[touching > 0])
    return ndimage.binary_dilation(keep, iterations=max(int(STRINGS_GROW * width), 1)) & garment


def emphasize_seams(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    strength, garment = seam_ridges(rgb, alpha)
    if not garment.any():
        return rgb
    strength = ndimage.gaussian_filter(strength, 0.7)
    print(f"Drew {(strength > 0.5).sum() / garment.sum():.1%} of the photo's garment darker as seam lines")
    return rgb * (1.0 - SEAM_DARKEN * strength)[:, :, None]
