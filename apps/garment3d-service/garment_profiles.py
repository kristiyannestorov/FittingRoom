from dataclasses import dataclass


@dataclass(frozen=True)
class BakeProfile:
    map_parts: bool
    neck_label: bool
    map_legs: bool = False
    seam_lines: bool = False
    drawstrings: bool = False


TOP = BakeProfile(map_parts=True, neck_label=True)
OPEN_NECK_TOP = BakeProfile(map_parts=True, neck_label=False)
LEGS = BakeProfile(map_parts=False, neck_label=False, map_legs=True)

PRODUCT_TYPE_PROFILES = {
    "T_SHIRT": TOP,
    "LONG_SLEEVE": TOP,
    "HOODIE": BakeProfile(map_parts=True, neck_label=False, seam_lines=True, drawstrings=True),
    "DRESS": BakeProfile(map_parts=False, neck_label=True),
    "SHORTS": LEGS,
    "PANTS": LEGS,
}

CATEGORY_PROFILES = {
    "HENLEY": OPEN_NECK_TOP,
    "BUTTON_UP": OPEN_NECK_TOP,
    "ZIP_UP": BakeProfile(map_parts=True, neck_label=False, seam_lines=True),
}


def profile_for(product_type: str | None, category: str | None = None) -> BakeProfile:
    by_type = PRODUCT_TYPE_PROFILES.get((product_type or "").upper(), TOP)
    by_category = CATEGORY_PROFILES.get((category or "").upper())
    if by_category is None or not by_type.map_parts:
        return by_type
    return by_category
