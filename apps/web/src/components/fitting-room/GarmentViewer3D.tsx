'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Environment, OrbitControls, useGLTF, useTexture } from '@react-three/drei';
import * as THREE from 'three';
import { clone as cloneSkinnedScene } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import {
  garmentSlotForProductType,
  type GarmentSlot,
  type Gender,
  type ProductType,
} from '@zed/contracts';

type CameraView = 'front' | 'back' | 'left' | 'right';

interface Framing {
  target: THREE.Vector3;
  distance: number;
  eyeHeight: number;
}

const TORSO_FRAMING: Framing = { target: new THREE.Vector3(0, 1, 0), distance: 2.6, eyeHeight: 1.3 };
const FULL_BODY_FRAMING: Framing = {
  target: new THREE.Vector3(0, 0.9, 0),
  distance: 3.4,
  eyeHeight: 1.15,
};

const VIEW_DIRECTIONS: Record<CameraView, [number, number]> = {
  front: [0, 1],
  back: [0, -1],
  left: [-1, 0],
  right: [1, 0],
};

function cameraPosition(view: CameraView, framing: Framing): THREE.Vector3 {
  const [x, z] = VIEW_DIRECTIONS[view];
  return new THREE.Vector3(x * framing.distance, framing.eyeHeight, z * framing.distance);
}

const FABRIC_NORMAL_URL = '/fabric/cotton-normal.jpg';
const FABRIC_ROUGHNESS_URL = '/fabric/cotton-roughness.jpg';
const FABRIC_TILE_REPEAT = 8;

interface FabricMaps {
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

const FLEECE_NORMAL_URL = '/fabric/fleece-normal.jpg';
const FLEECE_ROUGHNESS_URL = '/fabric/fleece-roughness.jpg';
const FLEECE_DETAIL_SCALE = 0.55;
const CLOTH_SHEEN = 0.5;
const CLOTH_SHEEN_ROUGHNESS = 0.8;

function useFabricMaps(urls: [string, string] = [FABRIC_NORMAL_URL, FABRIC_ROUGHNESS_URL]): FabricMaps {
  const [normalMap, roughnessMap] = useTexture(urls);

  useEffect(() => {
    for (const tex of [normalMap, roughnessMap]) {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(FABRIC_TILE_REPEAT, FABRIC_TILE_REPEAT);
      tex.needsUpdate = true;
    }
  }, [normalMap, roughnessMap]);

  return { normalMap, roughnessMap };
}

const FLEECE_URLS: [string, string] = [FLEECE_NORMAL_URL, FLEECE_ROUGHNESS_URL];

function clothMaterial(
  texture: THREE.Texture,
  fleece: FabricMaps,
  ownNormal: THREE.Texture | null,
  occlusion: boolean,
): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    map: texture,
    roughness: 1,
    roughnessMap: fleece.roughnessMap,
    metalness: 0,
    sheen: CLOTH_SHEEN,
    sheenRoughness: CLOTH_SHEEN_ROUGHNESS,
    sheenColor: new THREE.Color(1, 1, 1),
    sheenColorMap: texture,
    side: THREE.DoubleSide,
    vertexColors: occlusion,
  });
  if (!ownNormal) {
    material.normalMap = fleece.normalMap;
    material.normalScale = new THREE.Vector2(FLEECE_DETAIL_SCALE, -FLEECE_DETAIL_SCALE);
    return material;
  }
  material.normalMap = ownNormal;
  material.normalScale = new THREE.Vector2(1, -1);
  const detail = fleece.normalMap;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.detailNormalMap = { value: detail };
    shader.uniforms.detailRepeat = { value: detail.repeat.clone() };
    shader.uniforms.detailScale = { value: new THREE.Vector2(FLEECE_DETAIL_SCALE, -FLEECE_DETAIL_SCALE) };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <normalmap_pars_fragment>',
        `#include <normalmap_pars_fragment>
uniform sampler2D detailNormalMap;
uniform vec2 detailRepeat;
uniform vec2 detailScale;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
#ifdef USE_NORMALMAP_TANGENTSPACE
	vec3 detailN = texture2D( detailNormalMap, vNormalMapUv * detailRepeat ).xyz * 2.0 - 1.0;
	detailN.xy *= detailScale;
	mapN = normalize( vec3( mapN.xy + detailN.xy, mapN.z * detailN.z ) );
	normal = normalize( tbn * mapN );
#endif`,
      );
  };
  material.customProgramCacheKey = () => 'cloth-detail-normal';
  return material;
}

interface SlotFitConfig {
  bonePriority: RegExp[];
  hiddenAvatarMeshes: string[];
}

const SLOT_FITS: Record<GarmentSlot, SlotFitConfig> = {
  TOP: {
    bonePriority: [/spine2/i, /chest/i, /spine1/i, /torso/i, /spine/i],
    hiddenAvatarMeshes: ['Wolf3D_Outfit_Top'],
  },
  BOTTOM: {
    bonePriority: [/hips/i, /pelvis/i, /spine$/i, /torso/i],
    hiddenAvatarMeshes: ['Wolf3D_Outfit_Bottom'],
  },
  FULL_BODY: {
    bonePriority: [/spine2/i, /chest/i, /spine1/i, /torso/i, /spine/i],
    hiddenAvatarMeshes: ['Wolf3D_Outfit_Top', 'Wolf3D_Outfit_Bottom'],
  },
};

const AVATAR_CLOTHING_WORN_AS_SKIN: Partial<Record<ProductType, string[]>> = {
  SHORTS: ['Wolf3D_Outfit_Bottom'],
  HOODIE: ['Wolf3D_Outfit_Top'],
  DRESS: ['Wolf3D_Outfit_Top', 'Wolf3D_Outfit_Bottom'],
};
const AVATAR_SKIN_MESH = 'Wolf3D_Body';

const TARGET_HEIGHT_RATIO: Record<ProductType, number> = {
  T_SHIRT: 0.45,
  LONG_SLEEVE: 0.45,
  HOODIE: 0.48,
  SHORTS: 0.25,
  PANTS: 0.5,
  DRESS: 0.62,
};

function findAttachmentBone(root: THREE.Object3D, slot: GarmentSlot): THREE.Object3D {
  for (const pattern of SLOT_FITS[slot].bonePriority) {
    let match: THREE.Object3D | null = null;
    root.traverse((obj) => {
      if (!match && (obj as THREE.Bone).isBone && pattern.test(obj.name)) match = obj;
    });
    if (match) return match;
  }

  let anyBone: THREE.Object3D | null = null;
  root.traverse((obj) => {
    if (!anyBone && (obj as THREE.Bone).isBone) anyBone = obj;
  });

  return anyBone ?? root;
}

function hideAvatarsOwnClothingForSlot(
  root: THREE.Object3D,
  slot: GarmentSlot,
  keep: string[] = [],
): () => void {
  const hidden = SLOT_FITS[slot].hiddenAvatarMeshes
    .filter((name) => !keep.includes(name))
    .map((name) => root.getObjectByName(name))
    .filter((obj): obj is THREE.Object3D => Boolean(obj));

  const previous = hidden.map((obj) => obj.visible);
  for (const obj of hidden) obj.visible = false;

  return () => {
    hidden.forEach((obj, i) => {
      obj.visible = previous[i];
    });
  };
}

const SKIN_UNDER_HEM_M = 0.04;

function wearAvatarClothingAsSkin(
  root: THREE.Object3D,
  names: string[],
  coveredAboveY: number | null = null,
): () => void {
  const skin = root.getObjectByName(AVATAR_SKIN_MESH) as THREE.Mesh | undefined;
  if (!skin?.isMesh || names.length === 0) return () => {};

  const restores: Array<() => void> = [];
  for (const name of names) {
    const mesh = root.getObjectByName(name) as THREE.Mesh | undefined;
    if (!mesh?.isMesh) continue;
    const previousMaterial = mesh.material;
    const previousVisible = mesh.visible;
    const previousGeometry = mesh.geometry;
    const material = plainSkinMaterial(skin);
    mesh.material = material;
    mesh.visible = true;
    const trimmed = coveredAboveY === null ? null : trimCoveredTriangles(mesh, coveredAboveY);
    if (trimmed) mesh.geometry = trimmed;
    restores.push(() => {
      mesh.material = previousMaterial;
      mesh.visible = previousVisible;
      mesh.geometry = previousGeometry;
      material.dispose();
      trimmed?.dispose();
    });
  }
  return () => restores.forEach((restore) => restore());
}

function plainSkinMaterial(skin: THREE.Mesh): THREE.MeshStandardMaterial {
  const source = (Array.isArray(skin.material) ? skin.material[0] : skin.material) as THREE.MeshStandardMaterial;
  const material = source.clone();
  material.map = null;
  material.normalMap = null;
  material.color.set(sampleSkinTone(skin, source));
  return material;
}

const GARMENT_UNDERLAY_MESH = 'Underlay';

function worldVertexYs(mesh: THREE.Mesh): Float32Array {
  const count = mesh.geometry.getAttribute('position').count;
  const ys = new Float32Array(count);
  const vertex = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    mesh.getVertexPosition(i, vertex);
    ys[i] = mesh.localToWorld(vertex).y;
  }
  return ys;
}

function trimCoveredTriangles(mesh: THREE.Mesh, coveredAboveY: number): THREE.BufferGeometry | null {
  const index = mesh.geometry.getIndex();
  if (!index) return null;
  const ys = worldVertexYs(mesh);
  const kept: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
    if (Math.min(ys[a], ys[b], ys[c]) < coveredAboveY) kept.push(a, b, c);
  }
  const trimmed = mesh.geometry.clone();
  trimmed.setIndex(kept);
  trimmed.clearGroups();
  return trimmed;
}

function sampleSkinTone(skin: THREE.Mesh, material: THREE.MeshStandardMaterial): THREE.Color {
  const image = material.map?.image as (CanvasImageSource & { width?: number; height?: number }) | undefined;
  const fallback = material.color.clone();
  const uvAttribute = skin.geometry.getAttribute('uv');
  if (!image || !uvAttribute || typeof document === 'undefined') return fallback;
  try {
    const width = Math.min(image.width ?? 512, 1024);
    const height = Math.min(image.height ?? 512, 1024);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return fallback;
    ctx.drawImage(image, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);

    const reds: number[] = [];
    const greens: number[] = [];
    const blues: number[] = [];
    for (let vertex = 0; vertex < uvAttribute.count; vertex++) {
      const u = uvAttribute.getX(vertex);
      const v = uvAttribute.getY(vertex);
      const x = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
      const y = Math.min(height - 1, Math.max(0, Math.round(v * (height - 1))));
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue;
      reds.push(data[i]);
      greens.push(data[i + 1]);
      blues.push(data[i + 2]);
    }
    if (reds.length === 0) return fallback;

    const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1] / 255;
    return new THREE.Color(median(reds), median(greens), median(blues))
      .convertSRGBToLinear()
      .multiply(material.color);
  } catch {
    return fallback;
  }
}

function applyGarmentSurface(
  root: THREE.Object3D,
  slot: GarmentSlot,
  surface: { texture: THREE.Texture } | { colorHex: string },
): () => void {
  const restores: Array<() => void> = [];

  for (const name of SLOT_FITS[slot].hiddenAvatarMeshes) {
    const mesh = root.getObjectByName(name) as THREE.Mesh | undefined;
    if (!mesh?.isMesh) continue;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      const previousMap = material.map;
      const previousColor = material.color.clone();

      if ('texture' in surface) {
        material.map = surface.texture;
        material.color.set(0xffffff);
      } else {
        material.map = null;
        material.color.set(surface.colorHex);
      }
      material.needsUpdate = true;

      restores.push(() => {
        material.map = previousMap;
        material.color.copy(previousColor);
        material.needsUpdate = true;
      });
    }
  }

  return () => restores.forEach((restore) => restore());
}

function ColoredGarmentLayer({
  avatarScene,
  colorHex,
  slot,
}: {
  avatarScene: THREE.Object3D;
  colorHex: string;
  slot: GarmentSlot;
}) {
  useEffect(
    () => applyGarmentSurface(avatarScene, slot, { colorHex }),
    [avatarScene, slot, colorHex],
  );

  return null;
}

function BakedGarmentLayer({
  avatarScene,
  textureUrl,
  slot,
}: {
  avatarScene: THREE.Object3D;
  textureUrl: string;
  slot: GarmentSlot;
}) {
  const texture = useTexture(textureUrl);

  useEffect(() => {
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);

  useEffect(
    () => applyGarmentSurface(avatarScene, slot, { texture }),
    [avatarScene, slot, texture],
  );

  return null;
}

function rebindToAvatarSkeleton(garment: THREE.SkinnedMesh, avatarScene: THREE.Object3D): boolean {
  const avatarBones = new Map<string, THREE.Bone>();
  avatarScene.traverse((object) => {
    if ((object as THREE.Bone).isBone) avatarBones.set(object.name, object as THREE.Bone);
  });

  const bones: THREE.Bone[] = [];
  for (const bone of garment.skeleton.bones) {
    let source: THREE.Object3D | null = bone;
    let match: THREE.Bone | undefined;
    while (source && !match) {
      match = avatarBones.get(source.name);
      source = source.parent;
    }
    if (!match) return false;
    bones.push(match);
  }

  garment.bind(new THREE.Skeleton(bones, garment.skeleton.boneInverses), garment.bindMatrix);
  return true;
}

function LibraryGarmentLayer({
  avatarScene,
  meshUrl,
  meshName,
  textureUrl,
  productType,
  slot,
}: {
  avatarScene: THREE.Object3D;
  meshUrl: string;
  meshName: string;
  textureUrl: string;
  productType: ProductType;
  slot: GarmentSlot;
}) {
  const gltf = useGLTF(meshUrl);
  const texture = useTexture(textureUrl);
  const fleece = useFabricMaps(FLEECE_URLS);

  useEffect(() => {
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);

  useEffect(() => {
    const scene = cloneSkinnedScene(gltf.scene);
    const garment = scene.getObjectByName(meshName) as THREE.SkinnedMesh | undefined;
    if (!garment?.isSkinnedMesh) return;

    if (!rebindToAvatarSkeleton(garment, avatarScene)) return;

    const own = (Array.isArray(garment.material) ? garment.material[0] : garment.material) as THREE.MeshStandardMaterial;
    const occlusion = Boolean(garment.geometry.getAttribute('color'));
    const material = clothMaterial(texture, fleece, own.normalMap ?? null, occlusion);
    garment.material = material;
    garment.frustumCulled = false;

    const asSkin = AVATAR_CLOTHING_WORN_AS_SKIN[productType] ?? [];
    const restoreAvatarClothing = hideAvatarsOwnClothingForSlot(avatarScene, slot, asSkin);
    avatarScene.add(garment);
    const underlay = scene.getObjectByName(GARMENT_UNDERLAY_MESH) as THREE.SkinnedMesh | undefined;
    const skin = avatarScene.getObjectByName(AVATAR_SKIN_MESH) as THREE.Mesh | undefined;
    let underlayMaterial: THREE.Material | null = null;
    if (underlay?.isSkinnedMesh && skin?.isMesh && rebindToAvatarSkeleton(underlay, avatarScene)) {
      underlayMaterial = plainSkinMaterial(skin);
      underlay.material = underlayMaterial;
      underlay.frustumCulled = false;
      avatarScene.add(underlay);
    }
    avatarScene.updateMatrixWorld(true);
    const hemY = slot === 'BOTTOM' ? worldVertexYs(garment).reduce((a, b) => Math.min(a, b)) : null;
    const restoreSkin = wearAvatarClothingAsSkin(
      avatarScene,
      asSkin,
      hemY === null ? null : hemY + SKIN_UNDER_HEM_M,
    );

    return () => {
      avatarScene.remove(garment);
      if (underlay && underlayMaterial) {
        avatarScene.remove(underlay);
        underlayMaterial.dispose();
      }
      material.dispose();
      restoreSkin();
      restoreAvatarClothing();
    };
  }, [avatarScene, gltf.scene, meshName, texture, fleece, productType, slot]);

  return null;
}

interface GarmentFit {
  scale: number;
  anchor: THREE.Vector3;
}

function computeGarmentFit(
  avatarScene: THREE.Object3D,
  garmentScene: THREE.Object3D,
  productType: ProductType,
): GarmentFit {
  const avatarBox = new THREE.Box3().setFromObject(avatarScene);
  const avatarHeight = avatarBox.max.y - avatarBox.min.y;

  const garmentBox = new THREE.Box3().setFromObject(garmentScene);
  const garmentHeight = garmentBox.max.y - garmentBox.min.y;
  const garmentCenter = new THREE.Vector3();
  garmentBox.getCenter(garmentCenter);

  const targetHeightRatio = TARGET_HEIGHT_RATIO[productType];
  const scale =
    avatarHeight > 0 && garmentHeight > 0 ? (avatarHeight * targetHeightRatio) / garmentHeight : 1;

  return { scale, anchor: new THREE.Vector3(garmentCenter.x, garmentBox.max.y, garmentCenter.z) };
}

const CLEARANCE_INFLATE = 1.15;

function applyGarmentFit(garmentScene: THREE.Object3D, fit: GarmentFit, sizeScale: number): void {
  const totalScale = fit.scale * CLEARANCE_INFLATE * sizeScale;
  garmentScene.scale.setScalar(totalScale);
  garmentScene.position.set(
    -fit.anchor.x * totalScale,
    -fit.anchor.y * totalScale,
    -fit.anchor.z * totalScale,
  );
}

function humanizeAvatarMaterials(root: THREE.Object3D, fabric: FabricMaps): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const upgraded = materials.map((material) => {
      if (!(material instanceof THREE.MeshStandardMaterial)) return material;
      const name = material.name ?? '';

      if (/outfit/i.test(name)) {
        const physical = toPhysical(material);
        physical.roughness = 1;
        physical.roughnessMap = fabric.roughnessMap;
        physical.normalMap = fabric.normalMap;
        physical.normalScale = new THREE.Vector2(0.7, 0.7);
        return physical;
      }

      if (/eye/i.test(name)) {
        const physical = toPhysical(material);
        physical.roughness = 0.05;
        physical.clearcoat = 1;
        physical.clearcoatRoughness = 0.05;
        physical.envMapIntensity = 1.4;
        return physical;
      }

      if (/skin|head|body/i.test(name)) {
        const physical = toPhysical(material);
        physical.roughness = 0.55;
        physical.sheen = 0.35;
        physical.sheenRoughness = 0.6;
        physical.sheenColor = new THREE.Color(0xffe4d6);
        physical.envMapIntensity = 0.6;
        return physical;
      }

      if (/teeth|tongue/i.test(name)) {
        const physical = toPhysical(material);
        physical.roughness = 0.35;
        physical.clearcoat = 0.4;
        return physical;
      }

      return material;
    });

    mesh.material = Array.isArray(mesh.material) ? upgraded : upgraded[0];
  });
}

function toPhysical(source: THREE.MeshStandardMaterial): THREE.MeshPhysicalMaterial {
  const physical = new THREE.MeshPhysicalMaterial();
  THREE.Material.prototype.copy.call(physical, source);
  physical.color.copy(source.color);
  physical.map = source.map;
  physical.roughness = source.roughness;
  physical.roughnessMap = source.roughnessMap;
  physical.metalness = source.metalness;
  physical.metalnessMap = source.metalnessMap;
  physical.normalMap = source.normalMap;
  physical.normalScale = source.normalScale.clone();
  physical.emissive.copy(source.emissive);
  physical.emissiveMap = source.emissiveMap;
  physical.emissiveIntensity = source.emissiveIntensity;
  physical.aoMap = source.aoMap;
  physical.aoMapIntensity = source.aoMapIntensity;
  physical.envMap = source.envMap;
  physical.envMapIntensity = source.envMapIntensity;
  physical.flatShading = source.flatShading;
  physical.vertexColors = source.vertexColors;
  return physical;
}

function GarmentMeshLayer({
  avatarScene,
  garmentUrl,
  productType,
  slot,
  sizeScale,
}: {
  avatarScene: THREE.Object3D;
  garmentUrl: string;
  productType: ProductType;
  slot: GarmentSlot;
  sizeScale: number;
}) {
  const garmentGltf = useGLTF(garmentUrl);

  const garmentScene = useMemo(() => garmentGltf.scene.clone(true), [garmentGltf.scene]);

  const garmentFit = useMemo(
    () => computeGarmentFit(avatarScene, garmentScene, productType),
    [avatarScene, garmentScene, productType],
  );

  useEffect(() => {
    const restoreAvatarClothing = hideAvatarsOwnClothingForSlot(avatarScene, slot);
    const attachmentBone = findAttachmentBone(avatarScene, slot);
    attachmentBone.add(garmentScene);
    return () => {
      attachmentBone.remove(garmentScene);
      restoreAvatarClothing();
    };
  }, [avatarScene, garmentScene, slot]);

  useEffect(() => {
    applyGarmentFit(garmentScene, garmentFit, sizeScale);
  }, [garmentScene, garmentFit, sizeScale]);

  return null;
}

function AvatarOutfit({ avatarUrl, body, pieces }: { avatarUrl: string; body: Gender; pieces: OutfitPiece[] }) {
  const avatarGltf = useGLTF(avatarUrl);
  const fabric = useFabricMaps();

  const avatarScene = useMemo(() => {
    const scene = cloneSkinnedScene(avatarGltf.scene);
    humanizeAvatarMaterials(scene, fabric);
    return scene;
  }, [avatarGltf.scene, fabric]);

  return (
    <>
      <primitive object={avatarScene} />
      {pieces.map((piece) => {
        const slot = garmentSlotForProductType(piece.productType);
        const meshUrl = piece.garmentMeshUrls?.[body] ?? piece.garmentMeshUrl;
        if (piece.garmentTextureUrl && meshUrl && piece.garmentMeshName) {
          return (
            <LibraryGarmentLayer
              key={`${slot}-library-${meshUrl}-${piece.garmentTextureUrl}`}
              avatarScene={avatarScene}
              meshUrl={meshUrl}
              meshName={piece.garmentMeshName}
              textureUrl={piece.garmentTextureUrl}
              productType={piece.productType}
              slot={slot}
            />
          );
        }
        if (piece.garmentTextureUrl) {
          return (
            <BakedGarmentLayer
              key={`${slot}-texture-${piece.garmentTextureUrl}`}
              avatarScene={avatarScene}
              textureUrl={piece.garmentTextureUrl}
              slot={slot}
            />
          );
        }
        if (piece.garmentUrl) {
          return (
            <GarmentMeshLayer
              key={`${slot}-mesh-${piece.garmentUrl}`}
              avatarScene={avatarScene}
              garmentUrl={piece.garmentUrl}
              productType={piece.productType}
              slot={slot}
              sizeScale={piece.sizeScale ?? 1}
            />
          );
        }
        if (piece.garmentColorHex) {
          return (
            <ColoredGarmentLayer
              key={`${slot}-color-${piece.garmentColorHex}`}
              avatarScene={avatarScene}
              colorHex={piece.garmentColorHex}
              slot={slot}
            />
          );
        }
        return null;
      })}
    </>
  );
}

function CameraRig({ request, framing }: { request: ViewRequest; framing: Framing }) {
  const { camera } = useThree();
  const controlsRef = useRef<OrbitControlsImpl>(null);

  useEffect(() => {
    camera.position.copy(cameraPosition(request.view, framing));
    camera.lookAt(framing.target);
    controlsRef.current?.target.copy(framing.target);
    controlsRef.current?.update();
  }, [request, framing, camera]);

  return (
    <OrbitControls
      ref={controlsRef}
      enablePan={false}
      minDistance={1.4}
      maxDistance={4.5}
      target={framing.target}
    />
  );
}

interface ViewRequest {
  view: CameraView;
  nonce: number;
}

export interface OutfitPiece {
  garmentUrl?: string;
  garmentTextureUrl?: string;
  garmentMeshUrl?: string;
  garmentMeshUrls?: Record<Gender, string>;
  garmentMeshName?: string;
  garmentColorHex?: string;
  productType: ProductType;
  sizeScale?: number;
}

const BODY_LABEL: Record<Gender, string> = { FEMALE: 'Women', MALE: 'Men' };

export interface GarmentViewer3DProps {
  avatarUrls: Record<Gender, string>;
  initialBody?: Gender;
  lockBody?: boolean;
  pieces: OutfitPiece[];
}

export function GarmentViewer3D({
  avatarUrls,
  initialBody = 'MALE',
  lockBody = false,
  pieces,
}: GarmentViewer3DProps) {
  const [viewRequest, setViewRequest] = useState<ViewRequest>({ view: 'front', nonce: 0 });
  const showView = (view: CameraView) => setViewRequest((last) => ({ view, nonce: last.nonce + 1 }));
  const [pickedBody, setPickedBody] = useState<Gender>(initialBody);
  const body = lockBody ? initialBody : pickedBody;
  const framing = pieces.some((piece) => garmentSlotForProductType(piece.productType) !== 'TOP')
    ? FULL_BODY_FRAMING
    : TORSO_FRAMING;

  return (
    <div className="flex flex-col gap-3">
      <div className="aspect-square overflow-hidden rounded-xl bg-black/5">
        <Canvas
          camera={{ position: cameraPosition('front', framing).toArray(), fov: 35 }}
          gl={{ toneMapping: THREE.ACESFilmicToneMapping }}
        >
          <ambientLight intensity={0.25} />
          <directionalLight position={[3, 5, 4]} intensity={1.3} color="#fff4e6" />
          <directionalLight position={[-4, 2, 2]} intensity={0.4} color="#dbe9ff" />
          <directionalLight position={[0, 3, -5]} intensity={0.5} color="#ffffff" />
          <Environment preset="apartment" />
          <Suspense fallback={null}>
            <AvatarOutfit key={body} avatarUrl={avatarUrls[body]} body={body} pieces={pieces} />
          </Suspense>
          <CameraRig request={viewRequest} framing={framing} />
        </Canvas>
      </div>
      <div className="flex items-center justify-center gap-2 text-xs">
        {lockBody ? (
          <span className="rounded-md border border-black/20 bg-black/5 px-3 py-1 uppercase tracking-wide text-black/60">
            {BODY_LABEL[body]}
          </span>
        ) : (
          (['FEMALE', 'MALE'] as const).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setPickedBody(g)}
              aria-pressed={body === g}
              className={`rounded-md border px-3 py-1 uppercase tracking-wide ${
                body === g
                  ? 'border-black bg-black text-white'
                  : 'border-black/20 hover:bg-black/5'
              }`}
            >
              {BODY_LABEL[g]}
            </button>
          ))
        )}
        <span className="mx-1 h-4 w-px bg-black/15" aria-hidden />
        {(['front', 'back', 'left', 'right'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => showView(v)}
            className="rounded-md border border-black/20 px-3 py-1 uppercase tracking-wide hover:bg-black/5"
          >
            {v}
          </button>
        ))}
        <button
          type="button"
          onClick={() => showView('front')}
          className="rounded-md border border-black/20 px-3 py-1 text-black/60 hover:bg-black/5"
        >
          Reset
        </button>
      </div>
      <p className="text-center text-xs text-black/40">Drag to rotate · scroll to zoom</p>
    </div>
  );
}
