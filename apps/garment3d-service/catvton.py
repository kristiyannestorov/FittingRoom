import hashlib
import os
import threading
from collections import OrderedDict
from dataclasses import dataclass

import numpy as np
import torch
from PIL import Image

BASE_MODEL = os.environ.get("TRYON_BASE_MODEL", "booksforcharlie/stable-diffusion-inpainting")

VAE_MODEL = os.environ.get("TRYON_VAE_MODEL", "stabilityai/sd-vae-ft-mse")

ATTENTION_REPO = os.environ.get("TRYON_ATTENTION_REPO", "zhengchong/CatVTON")

ATTENTION_SUBFOLDERS = {
    "upper": os.environ.get("TRYON_UPPER_ATTENTION", "vitonhd-16k-512"),
    "upper_long": os.environ.get("TRYON_UPPER_LONG_ATTENTION", "dresscode-16k-512"),
    "lower": os.environ.get("TRYON_LOWER_ATTENTION", "dresscode-16k-512"),
    "full": os.environ.get("TRYON_FULL_ATTENTION", "dresscode-16k-512"),
}

REGION_SAMPLERS = {
    "upper": os.environ.get("TRYON_UPPER_SAMPLER", "hybrid"),
    "upper_long": os.environ.get("TRYON_UPPER_LONG_SAMPLER", "dpm"),
    "lower": os.environ.get("TRYON_LOWER_SAMPLER", "hybrid"),
    "full": os.environ.get("TRYON_FULL_SAMPLER", "hybrid"),
}

LCM_LORA_REPO = os.environ.get("TRYON_LCM_LORA_REPO", "latent-consistency/lcm-lora-sdv1-5")

LCM_LORA_FILE = os.environ.get("TRYON_LCM_LORA_FILE", "pytorch_lora_weights.safetensors")

WIDTH = int(os.environ.get("TRYON_WIDTH", "384"))

HEIGHT = int(os.environ.get("TRYON_HEIGHT", "512"))

SEED = int(os.environ.get("TRYON_SEED", "42"))

CONDITION_LATENT_CACHE_SIZE = 32

_PIPELINE = None

_LOCK = threading.Lock()


@dataclass(frozen=True)
class Sampler:
    scheduler: str
    steps: int
    guidance: float
    guidance_until: float
    refine_from: float | None = None


SAMPLERS = {
    "lcm": Sampler("lcm", steps=6, guidance=1.0, guidance_until=0.0),
    "dpm": Sampler("dpm", steps=16, guidance=2.5, guidance_until=0.6),
    "ddim": Sampler("ddim", steps=30, guidance=2.5, guidance_until=1.0),
    "hybrid": Sampler("dpm", steps=16, guidance=2.5, guidance_until=1.0, refine_from=0.4),
}

for _region, _name in REGION_SAMPLERS.items():
    if _name not in SAMPLERS:
        raise ValueError(f"Sampler for {_region} must be one of {sorted(SAMPLERS)}, not {_name}")


class SkipAttnProcessor(torch.nn.Module):
    def __call__(self, attn, hidden_states, *args, **kwargs):
        return hidden_states


class LoRA:
    def __init__(self, model: torch.nn.Module, path: str, skip: str):
        from safetensors.torch import load_file

        weights = load_file(path)
        modules = {"lora_unet_" + name.replace(".", "_"): module for name, module in model.named_modules()}
        self.factors = []
        for key in [key for key in weights if key.endswith(".lora_down.weight")]:
            name = key.removesuffix(".lora_down.weight")
            module = modules.get(name)
            if module is None or skip in name:
                continue
            down = weights[key].float()
            up = weights[f"{name}.lora_up.weight"].float()
            rank = down.shape[0]
            alpha = float(weights[f"{name}.alpha"]) if f"{name}.alpha" in weights else rank
            self.factors.append((module.weight, down, up, alpha / rank))
        self.active = False

    def set_active(self, active: bool) -> None:
        if active == self.active:
            return
        sign = 1.0 if active else -1.0
        for weight, down, up, scale in self.factors:
            if down.ndim == 4 and down.shape[2:] != (1, 1):
                delta = torch.nn.functional.conv2d(down.permute(1, 0, 2, 3), up).permute(1, 0, 2, 3)
            else:
                delta = up.flatten(1) @ down.flatten(1)
            if delta.numel() == weight.numel():
                weight.data += sign * scale * delta.reshape(weight.shape)
        self.active = active


class CatVTON:
    def __init__(self):
        from diffusers import (
            AutoencoderKL,
            DDIMScheduler,
            DPMSolverMultistepScheduler,
            LCMScheduler,
            UNet2DConditionModel,
        )
        from diffusers.models.attention_processor import AttnProcessor2_0
        from huggingface_hub import hf_hub_download

        torch.set_num_threads(os.cpu_count() or 1)
        config = DDIMScheduler.load_config(BASE_MODEL, subfolder="scheduler")
        self.schedulers = {
            "lcm": LCMScheduler.from_config(config),
            "dpm": DPMSolverMultistepScheduler.from_config(
                config, algorithm_type="dpmsolver++", solver_order=2, use_karras_sigmas=True
            ),
            "ddim": DDIMScheduler.from_config(config),
        }
        self.vae = AutoencoderKL.from_pretrained(VAE_MODEL).eval()
        self.unet = UNet2DConditionModel.from_pretrained(BASE_MODEL, subfolder="unet").eval()

        processors = {
            name: AttnProcessor2_0() if name.endswith("attn1.processor") else SkipAttnProcessor()
            for name in self.unet.attn_processors
        }
        self.unet.set_attn_processor(processors)
        self.lcm = None
        if {"lcm", "hybrid"} & set(REGION_SAMPLERS.values()):
            self.lcm = LoRA(self.unet, hf_hub_download(LCM_LORA_REPO, LCM_LORA_FILE), skip="attn1")

        self.layers = [module for name, module in self.unet.named_modules() if name.endswith("attn1")]
        self.attention: dict[str, list[dict[str, torch.Tensor]]] = {}
        self.loaded = None
        self.condition_latents: OrderedDict[str, torch.Tensor] = OrderedDict()

    def _read_attention(self, subfolder: str) -> list[dict[str, torch.Tensor]]:
        from huggingface_hub import snapshot_download
        from safetensors.torch import load_file

        repo = snapshot_download(ATTENTION_REPO, allow_patterns=[f"{subfolder}/attention/*"])
        path = os.path.join(repo, subfolder, "attention", "model.safetensors")
        grouped: dict[int, dict[str, torch.Tensor]] = {}
        for key, tensor in load_file(path).items():
            index, param = key.split(".", 1)
            grouped.setdefault(int(index), {})[param] = tensor
        if len(grouped) != len(self.layers):
            raise RuntimeError(
                f"CatVTON checkpoint has {len(grouped)} attention layers, the UNet has {len(self.layers)}"
            )
        return [grouped[index] for index in sorted(grouped)]

    def use_attention(self, subfolder: str) -> None:
        if subfolder == self.loaded:
            return
        if subfolder not in self.attention:
            self.attention[subfolder] = self._read_attention(subfolder)
        for layer, state in zip(self.layers, self.attention[subfolder]):
            layer.load_state_dict(state, strict=True)
        self.loaded = subfolder

    def _encode(self, image: torch.Tensor) -> torch.Tensor:
        latent = self.vae.encode(image).latent_dist.mode()
        return latent * self.vae.config.scaling_factor

    def _encode_condition(self, garment: Image.Image) -> torch.Tensor:
        pixels = np.asarray(garment.convert("RGB"))
        key = hashlib.sha256(pixels.tobytes()).hexdigest()
        latent = self.condition_latents.get(key)
        if latent is None:
            latent = self._encode(_to_tensor(garment))
            self.condition_latents[key] = latent
            while len(self.condition_latents) > CONDITION_LATENT_CACHE_SIZE:
                self.condition_latents.popitem(last=False)
        self.condition_latents.move_to_end(key)
        return latent

    def _denoise(self, name: str, latents, timesteps, inputs, generator, guided_steps: int):
        sampler = SAMPLERS[name]
        scheduler = self.schedulers[sampler.scheduler]
        conditioned, unconditioned, mask_concat = inputs
        step_options = {"eta": 1.0} if sampler.scheduler == "ddim" else {}
        if self.lcm is not None:
            self.lcm.set_active(sampler.scheduler == "lcm")
        for index, t in enumerate(timesteps):
            if index < guided_steps:
                model_input = scheduler.scale_model_input(torch.cat([latents] * 2), t)
                model_input = torch.cat(
                    [model_input, torch.cat([mask_concat] * 2), torch.cat([unconditioned, conditioned])],
                    dim=1,
                )
                noise = self.unet(model_input, t, encoder_hidden_states=None, return_dict=False)[0]
                uncond, cond = noise.chunk(2)
                noise = uncond + sampler.guidance * (cond - uncond)
            else:
                model_input = scheduler.scale_model_input(latents, t)
                model_input = torch.cat([model_input, mask_concat, conditioned], dim=1)
                noise = self.unet(model_input, t, encoder_hidden_states=None, return_dict=False)[0]
            latents = scheduler.step(noise, t, latents, generator=generator, **step_options).prev_sample
        return latents

    @torch.no_grad()
    def __call__(
        self, person: Image.Image, garment: Image.Image, mask: Image.Image, sampler_name: str
    ) -> Image.Image:
        sampler = SAMPLERS[sampler_name]
        image = _to_tensor(person)
        mask_tensor = torch.from_numpy(
            (np.asarray(mask.convert("L")) >= 128).astype(np.float32)
        )[None, None]

        masked_latent = self._encode(image * (mask_tensor < 0.5))
        condition_latent = self._encode_condition(garment)
        mask_latent = torch.nn.functional.interpolate(
            mask_tensor, size=masked_latent.shape[-2:], mode="nearest"
        )
        inputs = (
            torch.cat([masked_latent, condition_latent], dim=-2),
            torch.cat([masked_latent, torch.zeros_like(condition_latent)], dim=-2),
            torch.cat([mask_latent, torch.zeros_like(mask_latent)], dim=-2),
        )
        generator = torch.Generator().manual_seed(SEED)
        noise = torch.randn(inputs[0].shape, generator=generator)

        if sampler.refine_from is None:
            scheduler = self.schedulers[sampler.scheduler]
            scheduler.set_timesteps(sampler.steps)
            guided = round(sampler.guidance_until * sampler.steps) if sampler.guidance > 1 else 0
            latents = self._denoise(
                sampler_name, noise * scheduler.init_noise_sigma, scheduler.timesteps, inputs, generator, guided
            )
        else:
            lcm = self.schedulers["lcm"]
            lcm.set_timesteps(SAMPLERS["lcm"].steps)
            draft = self._denoise("lcm", noise, lcm.timesteps, inputs, generator, 0)
            scheduler = self.schedulers[sampler.scheduler]
            scheduler.set_timesteps(sampler.steps)
            start = int(sampler.refine_from * sampler.steps)
            scheduler.set_begin_index(start)
            timesteps = scheduler.timesteps[start:]
            renoise = torch.randn(draft.shape, generator=generator)
            latents = scheduler.add_noise(draft, renoise, timesteps[:1])
            latents = self._denoise(sampler_name, latents, timesteps, inputs, generator, len(timesteps))

        latents = latents.split(latents.shape[-2] // 2, dim=-2)[0]
        decoded = self.vae.decode(latents / self.vae.config.scaling_factor).sample
        decoded = ((decoded[0] / 2 + 0.5).clamp(0, 1).permute(1, 2, 0).numpy() * 255).round()
        return Image.fromarray(decoded.astype(np.uint8))


def _to_tensor(image: Image.Image) -> torch.Tensor:
    array = np.asarray(image.convert("RGB")).astype(np.float32) / 127.5 - 1.0
    return torch.from_numpy(array).permute(2, 0, 1)[None]


def pipeline() -> CatVTON:
    global _PIPELINE
    with _LOCK:
        if _PIPELINE is None:
            _PIPELINE = CatVTON()
    return _PIPELINE


def release() -> None:
    global _PIPELINE
    with _LOCK:
        _PIPELINE = None


def warm_up() -> None:
    model = pipeline()
    blank = Image.new("RGB", (WIDTH, HEIGHT), (128, 128, 128))
    with _LOCK:
        for region in ("lower", "upper_long", "upper"):
            model.use_attention(ATTENTION_SUBFOLDERS[region])
        with torch.no_grad():
            latent = model._encode(_to_tensor(blank))
            inputs = torch.cat([latent] * 2, dim=-2)
            model_input = torch.cat([inputs, torch.zeros_like(inputs[:, :1]), inputs], dim=1)
            model.unet(model_input, 999, encoder_hidden_states=None, return_dict=False)


def generate(
    person: Image.Image, garment: Image.Image, mask: Image.Image, region: str
) -> Image.Image:
    model = pipeline()
    sampler = REGION_SAMPLERS[region]
    with _LOCK:
        model.use_attention(ATTENTION_SUBFOLDERS[region])
        return model(person, garment, mask, sampler)
