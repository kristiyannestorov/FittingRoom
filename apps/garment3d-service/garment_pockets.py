from __future__ import annotations

from dataclasses import dataclass, field

Point = tuple[float, float]


@dataclass(frozen=True)
class Kangaroo:
    right: tuple[Point, ...]
    left: tuple[Point, ...]
    top: tuple[Point, ...] = ()
    sewn: int = 1


@dataclass(frozen=True)
class Welt:
    opening: tuple[Point, Point]
    sewn: tuple[Point, Point]


@dataclass(frozen=True)
class Zip:
    path: tuple[Point, ...]
    width: float = 0.036


Pocket = Kangaroo | Welt | Zip


@dataclass(frozen=True)
class Pattern:
    cut: str
    pockets: tuple[Pocket, ...] = field(default_factory=tuple)

KANGAROO = Kangaroo(
    right=((0.137, 0.855), (0.117, 0.705), (0.200, 0.600), (0.249, 0.448)),
    left=((0.863, 0.855), (0.883, 0.705), (0.800, 0.600), (0.751, 0.448)),
)

CUT_POCKETS: dict[str, tuple[Pocket, ...]] = {"HOODIE": (KANGAROO,)}

PATTERNS: dict[str, Pattern] = {
    "nike-club-red": Pattern("HOODIE", (Kangaroo(
        right=((0.2099, 0.8656), (0.1782, 0.7211), (0.2250, 0.6412), (0.2640, 0.5510), (0.2934, 0.4541)),
        left=((0.9360, 0.8452), (0.9435, 0.6871), (0.8734, 0.5731), (0.7955, 0.4422)),
        top=((0.5473, 0.4320),),
    ),)),
    "atelier-black": Pattern("HOODIE", (Kangaroo(
        right=((0.0804, 0.8171), (0.0858, 0.6946), (0.2547, 0.5225)),
        left=((0.8954, 0.8171), (0.8928, 0.6977), (0.7802, 0.5256)),
    ),)),
    "globe-neon": Pattern("HOODIE", (Kangaroo(
        right=((0.1074, 0.7723), (0.1067, 0.6287), (0.1667, 0.5891), (0.2317, 0.5272), (0.2776, 0.4666)),
        left=((0.7874, 0.8082), (0.8313, 0.6881), (0.7858, 0.6114), (0.7764, 0.4994)),
    ),)),
    "flair-jacket": Pattern("HOODIE", (
        Welt(opening=((0.1202, 0.4770), (0.1069, 0.7671)), sewn=((0.1490, 0.4770), (0.1352, 0.7671))),
        Welt(opening=((0.8542, 0.4700), (0.8823, 0.7559)), sewn=((0.8253, 0.4700), (0.8509, 0.7559))),
    )),
    "gilet-navy": Pattern("HOODIE", (
        Zip(path=((0.2037, 0.5660), (0.1714, 0.6113), (0.1335, 0.6835), (0.0927, 0.7454), (0.0693, 0.8031))),
        Zip(path=((0.8873, 0.5753), (0.9191, 0.6320), (0.9471, 0.6835), (0.9764, 0.7247), (0.985, 0.7711))),
    )),
}

PRODUCT_PATTERNS: dict[str, str] = {
    **{
        slug: "nike-club-red"
        for slug in (
            "dox-m-hoodie-red", "dox-m-nike-hoodie-red", "nike-hoodie-red", "red-nike-test",
            "test-nike-red", "de-de", "de-ded", "erd-ede", "fg-h",
        )
    },
    "blanks-atelier-hoodie-black": "atelier-black",
    "w-hoodie-globe": "globe-neon",
    "dox-m-jacket": "flair-jacket",
    "dox-m-gilet": "gilet-navy",
}


def pockets_for(cut: str) -> tuple[Pocket, ...]:
    if cut.startswith("products/"):
        return PATTERNS[cut.split("/", 1)[1]].pockets
    return CUT_POCKETS.get(cut, ())


def pattern_path(slug: str | None) -> str | None:
    pattern = PRODUCT_PATTERNS.get(slug or "")
    return f"products/{pattern}" if pattern else None
