"""Which kind of garment a product photo shows.

The garment library holds a mesh per category where a category has a shape of its own (a
polo's collar and placket, a button-up's collar, a zip-up's open front), and the bake picks
it by the category the product was entered with. If it was entered wrongly (a polo filed as a
CREW_NECK tee, which is what a catalogue import does to every "Pique Polo T-shirt"), the
photo is painted onto the wrong shape, and the open collar lands on a closed neck.

So the admin form asks this first. Marqo-FashionSigLIP (Apache-2.0), a SigLIP ViT-B/16
fine-tuned on fashion product images, scores the photo against a few descriptions of
each category, zero-shot: no training data of our own, and a category is added by
writing its descriptions below.

Only the two ONNX encoders (int8, ~95 MB image + ~110 MB text) and the tokenizer are
fetched, so this runs on the onnxruntime the service already has, not a second torch
model. The text encoder runs once, on first use, to embed the descriptions and is then
dropped; only the image encoder stays loaded, small beside the try-on model's several GB.

Checked against the photos behind the products in the database (2026-09-28): it named
every polo, graphic tee, jeans, fleece shorts and hoodie correctly, including the ones
filed under the wrong category, and was unsure only between SHIFT and A_LINE on one dress.
"""

import os
import string
import threading

import numpy as np
from PIL import Image

MODEL_REPO = os.environ.get("CLASSIFIER_REPO", "Marqo/marqo-fashionSigLIP")
VISION_FILE = "onnx/vision_model_int8.onnx"
TEXT_FILE = "onnx/text_model_int8.onnx"
TOKENIZER_FILE = "tokenizer.json"

IMAGE_SIZE = 224

LOGIT_SCALE = 100.0

PRODUCT_TYPES = {
    "T_SHIRT": [
        "a short sleeve t-shirt",
        "a short sleeve top",
        "a short sleeve polo shirt",
    ],
    "LONG_SLEEVE": [
        "a long sleeve t-shirt",
        "a long sleeve shirt",
        "a long sleeve sweater",
    ],
    "HOODIE": [
        "a hoodie with a hood",
        "a hooded sweatshirt",
        "a zip up hoodie",
    ],
    "SHORTS": [
        "a pair of shorts",
        "knee length shorts",
    ],
    "PANTS": [
        "a pair of trousers",
        "a pair of long pants",
        "a pair of jeans",
    ],
    "DRESS": [
        "a dress",
        "a womens dress",
    ],
}

CATEGORIES = {
    "T_SHIRT": {
        "CREW_NECK": [
            "a plain crew neck t-shirt",
            "a basic round neck t-shirt",
            "a plain short sleeve tee with a round neckline",
        ],
        "V_NECK": [
            "a v-neck t-shirt",
            "a t-shirt with a v shaped neckline",
            "a short sleeve v neck tee",
        ],
        "GRAPHIC": [
            "a graphic t-shirt with a large printed design",
            "a t-shirt with a big print on the chest",
            "a printed band t-shirt",
        ],
        "POLO": [
            "a polo shirt with a collar and buttons",
            "a pique polo shirt",
            "a short sleeve polo with a buttoned placket",
        ],
    },
    "LONG_SLEEVE": {
        "HENLEY": [
            "a long sleeve henley shirt with buttons at the neck and no collar",
            "a henley top",
        ],
        "WAFFLE_KNIT": [
            "a waffle knit long sleeve top",
            "a thermal long sleeve shirt",
            "a plain long sleeve t-shirt",
            "a knitted sweater",
        ],
        "BUTTON_UP": [
            "a button up shirt with a collar",
            "a long sleeve button down shirt",
            "a dress shirt",
            "a womens blouse",
        ],
        "POLO": [
            "a long sleeve polo shirt",
            "a long sleeve polo with a collar and buttoned placket",
        ],
    },
    "HOODIE": {
        "PULLOVER": [
            "a pullover hoodie",
            "a hooded sweatshirt with a kangaroo pocket",
        ],
        "ZIP_UP": [
            "a zip up hoodie",
            "a full zip hooded jacket",
        ],
        "GRAPHIC": [
            "a hoodie with a large printed graphic",
            "a printed hoodie with a big design",
        ],
    },
    "SHORTS": {
        "CHINO": [
            "chino shorts",
            "cotton twill shorts",
            "cargo shorts",
        ],
        "DENIM": [
            "denim shorts",
            "jean shorts",
        ],
        "ATHLETIC": [
            "athletic shorts",
            "sports shorts",
            "sweat shorts with a drawstring",
            "basketball shorts",
        ],
    },
    "PANTS": {
        "CHINO": [
            "chino trousers",
            "cotton twill pants",
            "tailored trousers",
            "cargo pants",
        ],
        "DENIM": [
            "blue jeans",
            "denim jeans",
            "a pair of jeans",
        ],
        "ATHLETIC": [
            "sweatpants",
            "joggers with a drawstring",
            "track pants",
        ],
    },
    "DRESS": {
        "BODYCON": ["a tight bodycon dress", "a fitted stretch bodycon dress"],
        "A_LINE": ["an a-line dress", "a dress flaring from the waist into an a line skirt"],
        "WRAP": ["a wrap dress", "a dress with a wrap front and tie waist"],
        "MAXI": ["a maxi dress", "a floor length long dress"],
        "SLIP": ["a slip dress", "a silky slip dress with thin straps"],
        "BALL_GOWN": ["a ball gown", "a formal gown with a full skirt"],
        "SHIFT": ["a shift dress", "a straight loose shift dress"],
    },
}

_LOCK = threading.Lock()
_STATE: dict = {}


def load():
    with _LOCK:
        if _STATE:
            return _STATE
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from tokenizers import Tokenizer

        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, (os.cpu_count() or 2) // 2)
        providers = ["CPUExecutionProvider"]
        vision = ort.InferenceSession(hf_hub_download(MODEL_REPO, VISION_FILE), options, providers=providers)
        text = ort.InferenceSession(hf_hub_download(MODEL_REPO, TEXT_FILE), options, providers=providers)
        tokenizer = Tokenizer.from_file(hf_hub_download(MODEL_REPO, TOKENIZER_FILE))

        def embed_texts(texts: list[str]) -> np.ndarray:
            ids = np.array([tokenizer.encode(_canonical(t)).ids for t in texts], dtype=np.int64)
            return _normalise(text.run(None, {"input_ids": ids})[0])

        def class_embeddings(classes: dict[str, list[str]]) -> tuple[list[str], np.ndarray]:
            names = list(classes)
            means = [embed_texts(classes[name]).mean(axis=0) for name in names]
            return names, _normalise(np.stack(means))

        _STATE["vision"] = vision
        _STATE["types"] = class_embeddings(PRODUCT_TYPES)
        _STATE["categories"] = {
            product_type: class_embeddings(classes) for product_type, classes in CATEGORIES.items()
        }
        return _STATE


def _canonical(text: str) -> str:
    text = text.replace("_", " ").translate(str.maketrans("", "", string.punctuation))
    return " ".join(text.lower().split())


def _normalise(vectors: np.ndarray) -> np.ndarray:
    return vectors / np.linalg.norm(vectors, axis=-1, keepdims=True)


def _pixels(image: Image.Image) -> np.ndarray:
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        backdrop = Image.new("RGBA", image.size, (255, 255, 255, 255))
        image = Image.alpha_composite(backdrop, image)
    image = image.convert("RGB").resize((IMAGE_SIZE, IMAGE_SIZE), Image.BICUBIC)
    array = np.asarray(image, dtype=np.float32) / 255.0
    return ((array - 0.5) / 0.5).transpose(2, 0, 1)[None]


def _ranked(names: list[str], embeddings: np.ndarray, image_embedding: np.ndarray) -> list[dict]:
    logits = LOGIT_SCALE * (embeddings @ image_embedding)
    probabilities = np.exp(logits - logits.max())
    probabilities /= probabilities.sum()
    order = np.argsort(-probabilities)
    return [{"label": names[i], "confidence": round(float(probabilities[i]), 4)} for i in order]


def classify(images: list[Image.Image], product_type: str | None = None) -> dict:
    if not images:
        raise ValueError("classify needs at least one image")
    state = load()
    batch = np.concatenate([_pixels(image) for image in images])
    image_embedding = _normalise(_normalise(state["vision"].run(None, {"pixel_values": batch})[0]).mean(axis=0))

    types = _ranked(*state["types"], image_embedding)
    chosen = (product_type or types[0]["label"]).upper()
    if chosen not in state["categories"]:
        raise ValueError(f"Unknown product type {product_type!r} (known: {', '.join(CATEGORIES)})")
    return {
        "productType": chosen,
        "productTypes": types,
        "categories": _ranked(*state["categories"][chosen], image_embedding),
    }


def main() -> int:
    import argparse
    import json

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("images", nargs="+")
    ap.add_argument("--product-type")
    args = ap.parse_args()
    result = classify([Image.open(path) for path in args.images], args.product_type)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
