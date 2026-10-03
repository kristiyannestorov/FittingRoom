import numpy as np

SIDEWAYS_MARGIN = 0.15

END_BAND = 0.1

BOTTOM_TYPES = {"SHORTS", "PANTS"}


def _mirror_iou(mask: np.ndarray, axis: int) -> float:
    points = list(np.nonzero(mask))
    reflected = np.round(2 * points[axis].mean() - points[axis]).astype(int)
    low = min(int(reflected.min()), 0)
    shape = list(mask.shape)
    shape[axis] = max(int(reflected.max()) + 1, shape[axis]) - low

    original, mirrored = np.zeros(shape, bool), np.zeros(shape, bool)
    at = list(points)
    at[axis] = points[axis] - low
    original[tuple(at)] = True
    at[axis] = reflected - low
    mirrored[tuple(at)] = True
    return float((original & mirrored).sum() / (original | mirrored).sum())


def _row_runs(row: np.ndarray) -> int:
    return int(np.count_nonzero(np.diff(row.astype(np.int8)) == 1) + (1 if row[0] else 0))


def _end_bands(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    rows = np.flatnonzero(mask.any(axis=1))
    band = max(int(END_BAND * (rows[-1] - rows[0] + 1)), 1)
    return mask[rows[0] : rows[0] + band], mask[rows[-1] - band + 1 : rows[-1] + 1]


def _upright_score(mask: np.ndarray, product_type: str | None) -> float:
    top, bottom = _end_bands(mask)
    if (product_type or "").upper() in BOTTOM_TYPES:
        return float(np.mean([_row_runs(r) for r in bottom]) - np.mean([_row_runs(r) for r in top]))
    width = lambda band: np.mean([np.ptp(np.flatnonzero(r)) + 1 if r.any() else 0 for r in band])
    return float(width(bottom) - width(top)) / mask.shape[1]


def upright_turns(mask: np.ndarray, product_type: str | None = None) -> int:
    mask = np.asarray(mask, bool)
    if mask.sum() < 64:
        return 0
    rows = np.flatnonzero(mask.any(axis=1))
    cols = np.flatnonzero(mask.any(axis=0))
    mask = mask[rows[0] : rows[-1] + 1, cols[0] : cols[-1] + 1]

    left_right = _mirror_iou(mask, axis=1)
    top_bottom = _mirror_iou(mask, axis=0)
    if top_bottom - left_right < SIDEWAYS_MARGIN:
        return 0

    counter = _upright_score(np.rot90(mask, 1), product_type)
    clockwise = _upright_score(np.rot90(mask, 3), product_type)
    return 1 if counter >= clockwise else 3


def symmetry(mask: np.ndarray) -> tuple[float, float]:
    mask = np.asarray(mask, bool)
    rows = np.flatnonzero(mask.any(axis=1))
    cols = np.flatnonzero(mask.any(axis=0))
    mask = mask[rows[0] : rows[-1] + 1, cols[0] : cols[-1] + 1]
    return _mirror_iou(mask, axis=1), _mirror_iou(mask, axis=0)
