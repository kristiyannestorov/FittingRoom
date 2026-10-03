import os
import threading

import cv2
import numpy as np
from PIL import Image

PARSER_REPO = os.environ.get("TRYON_PARSER_REPO", "mattmdjaga/segformer_b2_clothes")

PARSER_FILE = os.environ.get("TRYON_PARSER_FILE", "onnx/model.onnx")

PARSER_SIZE = 512

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)

STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

(
    BACKGROUND,
    HAT,
    HAIR,
    SUNGLASSES,
    UPPER_CLOTHES,
    SKIRT,
    PANTS,
    DRESS,
    BELT,
    LEFT_SHOE,
    RIGHT_SHOE,
    FACE,
    LEFT_LEG,
    RIGHT_LEG,
    LEFT_ARM,
    RIGHT_ARM,
    BAG,
    SCARF,
) = range(18)

ARMS = (LEFT_ARM, RIGHT_ARM)

LEGS = (LEFT_LEG, RIGHT_LEG)

SHOES = (LEFT_SHOE, RIGHT_SHOE)

_SESSION = None

_LOCK = threading.Lock()


def _session():
    global _SESSION
    with _LOCK:
        if _SESSION is None:
            import onnxruntime as ort
            from huggingface_hub import hf_hub_download

            options = ort.SessionOptions()
            options.enable_cpu_mem_arena = False
            _SESSION = ort.InferenceSession(
                hf_hub_download(PARSER_REPO, PARSER_FILE),
                options,
                providers=["CPUExecutionProvider"],
            )
    return _SESSION


def parse(im: Image.Image) -> np.ndarray:
    small = im.convert("RGB").resize((PARSER_SIZE, PARSER_SIZE), Image.BILINEAR)
    pixels = (np.asarray(small, dtype=np.float32) / 255.0 - MEAN) / STD
    logits = _session().run(None, {"pixel_values": pixels.transpose(2, 0, 1)[None]})[0][0]
    logits = cv2.resize(logits.transpose(1, 2, 0), im.size, interpolation=cv2.INTER_LINEAR)
    return np.argmax(logits, axis=2).astype(np.uint8)
