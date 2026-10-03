import argparse
import os

import numpy as np
from PIL import Image

SIZE = 1024
WALES = 256
COURSES = 320
KNIT_DEPTH = 0.22
FIBRE_DEPTH = 0.35
MOTTLE_DEPTH = 0.6
NORMAL_STRENGTH = 2.2
ROUGHNESS_MEAN = 0.86
ROUGHNESS_SPREAD = 0.04


def _periodic_noise(rng, size: int, scale: float) -> np.ndarray:
    f = np.fft.fftfreq(size)
    fx, fy = np.meshgrid(f, f)
    radius = np.hypot(fx, fy) * size / scale
    amplitude = np.exp(-(radius**2))
    amplitude[0, 0] = 0.0
    phase = np.exp(2j * np.pi * rng.random((size, size)))
    field = np.real(np.fft.ifft2(amplitude * phase))
    return field / (np.abs(field).max() + 1e-12)


def _knit(size: int) -> np.ndarray:
    y, x = np.mgrid[0:size, 0:size] / size
    u = (x * WALES) % 1.0
    v = (y * COURSES) % 1.0
    leg = np.abs(u - 0.5) * 2.0
    loop = np.cos(np.pi * (leg - (1.0 - v) * 0.5)) ** 2
    return loop * np.sin(np.pi * v) ** 0.5


def _fibres(rng, size: int, count: int = 9000) -> np.ndarray:
    out = np.zeros((size, size))
    for _ in range(count):
        x0, y0 = rng.random(2) * size
        angle = rng.normal(0.0, 0.6) + (np.pi / 2 if rng.random() < 0.5 else 0.0)
        length = rng.uniform(6, 22)
        t = np.linspace(0, length, int(length * 2))
        xs = (x0 + np.cos(angle) * t).astype(int) % size
        ys = (y0 + np.sin(angle) * t).astype(int) % size
        out[ys, xs] += rng.uniform(0.3, 1.0)
    return out / (out.max() + 1e-12)


def build(size: int = SIZE, seed: int = 11) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    height = (
        KNIT_DEPTH * _knit(size)
        + FIBRE_DEPTH * _fibres(rng, size)
        + MOTTLE_DEPTH * _periodic_noise(rng, size, 24.0)
        + 0.3 * MOTTLE_DEPTH * _periodic_noise(rng, size, 90.0)
    )
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) / 2
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) / 2
    n = np.stack([-dx * NORMAL_STRENGTH, dy * NORMAL_STRENGTH, np.ones_like(height)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    normal = np.clip((n * 0.5 + 0.5) * 255 + 0.5, 0, 255).astype(np.uint8)
    mottle = _periodic_noise(rng, size, 40.0) * 0.7 + 0.3 * _fibres(rng, size, 4000)
    mottle = (mottle - mottle.mean()) / (mottle.std() + 1e-12)
    roughness = np.clip(ROUGHNESS_MEAN + ROUGHNESS_SPREAD * mottle, 0, 1)
    return normal, (roughness * 255 + 0.5).astype(np.uint8)


def main() -> int:
    ap = argparse.ArgumentParser(prog="fabric_maps")
    ap.add_argument("out_dir")
    args = ap.parse_args()
    normal, roughness = build()
    os.makedirs(args.out_dir, exist_ok=True)
    Image.fromarray(normal).save(os.path.join(args.out_dir, "fleece-normal.jpg"), quality=90, subsampling=0)
    Image.fromarray(roughness).save(os.path.join(args.out_dir, "fleece-roughness.jpg"), quality=90)
    print(f"wrote fleece-normal.jpg and fleece-roughness.jpg ({SIZE} px) to {args.out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
