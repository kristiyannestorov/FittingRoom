import asyncio
import ctypes
import gc
import logging
import os
import shutil
import sys
import tempfile
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("garment3d-service")

_HEAVY_WORK = threading.Lock()


def _release_try_on() -> None:
    if "catvton" in sys.modules:
        sys.modules["catvton"].release()


def _release_bake() -> None:
    if "bake_texture" in sys.modules:
        sys.modules["bake_texture"].release_rembg_session()


def _exclusive(release, work, *args, **kwargs):
    with _HEAVY_WORK:
        release()
        gc.collect()
        try:
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except OSError:
            pass
        return work(*args, **kwargs)


def _preload_try_on() -> None:
    try:
        with _HEAVY_WORK:
            import catvton
            import human_parsing

            human_parsing._session()
            catvton.warm_up()
        logger.info("Try-on models loaded")
    except Exception:
        logger.exception("Could not preload the try-on models, the first try-on will load them")


def _preload_classifier() -> None:
    try:
        import garment_classifier

        garment_classifier.load()
        logger.info("Garment classifier loaded")
    except Exception:
        logger.exception("Could not preload the garment classifier, the first photo will load it")


@asynccontextmanager
async def lifespan(_: FastAPI):
    threading.Thread(target=_preload_classifier, daemon=True).start()
    if os.environ.get("TRYON_PRELOAD", "1") == "1":
        threading.Thread(target=_preload_try_on, daemon=True).start()
    yield


app = FastAPI(title="garment3d-service", lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/bake")
async def bake_texture_endpoint(
    front: UploadFile = File(...),
    back: UploadFile | None = File(None),
    left: UploadFile | None = File(None),
    right: UploadFile | None = File(None),
    product_type: str = Form("T_SHIRT"),
    category: str | None = Form(None),
    gender: str | None = Form(None),
    product_slug: str | None = Form(None),
):
    import bake_texture

    try:
        source_path, mesh_name = bake_texture.garment_source(product_type, category, gender, product_slug)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error

    uploads = {"front": front, "back": back, "left": left, "right": right}
    provided = {name: f for name, f in uploads.items() if f is not None}

    tmpdir = Path(tempfile.mkdtemp())
    try:
        paths = {}
        for name, upload in provided.items():
            path = tmpdir / f"{name}.img"
            path.write_bytes(await upload.read())
            paths[name] = str(path)

        out_path = tmpdir / "texture.png"
        logger.info(
            f"Baking {product_type}/{category} ({gender or 'any body'}) texture onto "
            f"{mesh_name} of {bake_texture.library_relative_path(source_path)} from "
            f"{len(paths)} photo(s): {sorted(paths)}"
        )
        await asyncio.to_thread(
            _exclusive,
            _release_try_on,
            bake_texture.bake,
            paths,
            str(out_path),
            cache=False,
            mesh_name=mesh_name,
            source_path=source_path,
            product_type=product_type,
            category=category,
        )
        png_bytes = out_path.read_bytes()
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    logger.info(f"Done: {len(png_bytes)} byte PNG")
    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "X-Garment-Source": bake_texture.library_relative_path(source_path),
            "X-Garment-Mesh": mesh_name,
        },
    )


@app.post("/classify")
async def classify_endpoint(
    images: list[UploadFile] = File(...),
    product_type: str | None = Form(None),
):
    import io

    import garment_classifier
    from PIL import Image, UnidentifiedImageError

    try:
        photos = [Image.open(io.BytesIO(await upload.read())) for upload in images]
    except UnidentifiedImageError as error:
        raise HTTPException(400, f"Not an image: {error}") from error
    try:
        result = await asyncio.to_thread(garment_classifier.classify, photos, product_type)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    top = result["categories"][0]
    logger.info(
        f"Classified {len(photos)} photo(s) as {result['productType']}/{top['label']} "
        f"({top['confidence']:.0%})"
    )
    return result


_TRY_ONS: dict[str, asyncio.Task] = {}


@app.post("/tryon")
async def try_on_endpoint(
    person: UploadFile = File(...),
    garment: list[UploadFile] = File(...),
    product_type: list[str] = Form(...),
    request_id: str | None = Form(None),
):
    import tryon

    if len(garment) != len(product_type):
        raise HTTPException(400, "Send one product_type for every garment photo")

    task = _TRY_ONS.get(request_id) if request_id else None
    if task is None:
        person_bytes = await person.read()
        garments = [(await photo.read(), kind) for photo, kind in zip(garment, product_type)]
        logger.info(
            f"Try-on {'+'.join(product_type)} {request_id or ''}: {len(person_bytes)} byte photo"
        )
        task = asyncio.create_task(
            asyncio.to_thread(_exclusive, _release_bake, tryon.try_on, person_bytes, garments)
        )
        if request_id:
            _TRY_ONS[request_id] = task
            task.add_done_callback(lambda _: _TRY_ONS.pop(request_id, None))
    else:
        logger.info(f"Try-on {request_id} is already running, waiting for it")

    try:
        jpeg_bytes = await asyncio.shield(task)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error

    return Response(content=jpeg_bytes, media_type="image/jpeg")
