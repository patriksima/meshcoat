import * as THREE from 'three'
import type { ViewportRuntime } from './viewport/viewportRuntime'
import { readTargetRgba } from './paint/gpuResources'
import { brush } from './paint/brush'

export function pieceBounds(rt: ViewportRuntime, index: number): THREE.Box3 {
  const mesh = rt.pieces[index].mesh
  mesh.updateWorldMatrix(true, false)
  mesh.geometry.computeBoundingBox()
  return mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
}

/** Projected boxes are aiming aids, not a claim that the whole piece is visible. */
export function sceneFeedback(rt: ViewportRuntime): unknown {
  const camera = rt.sceneHandle!.camera
  camera.updateMatrixWorld(true)
  const bounds = new THREE.Box3()
  const pieces = rt.pieces.map((piece, index) => {
    const box = pieceBounds(rt, index)
    bounds.union(box)
    const projected: THREE.Vector3[] = []
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          projected.push(new THREE.Vector3(x, y, z).project(camera))
        }
      }
    }
    const xs = projected.map((v) => (v.x + 1) / 2),
      ys = projected.map((v) => (1 - v.y) / 2)
    return {
      index,
      name: piece.name,
      label: piece.alias || piece.name,
      visible: piece.mesh.visible,
      worldBounds: { min: box.min.toArray(), max: box.max.toArray() },
      screenBounds: {
        left: Math.min(...xs),
        right: Math.max(...xs),
        top: Math.min(...ys),
        bottom: Math.max(...ys)
      },
      textureSize: piece.stack.textureSize,
      channels: piece.stack.activeChannels(),
      selectedFaces: index === rt.activePieceIndex ? brush.selectedFaces().size : undefined,
      pixelSelection: !!piece.stack.pixelSelection
    }
  })
  const size = bounds.getSize(new THREE.Vector3())
  return {
    pieces,
    worldBounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
    suggestedDetailRadius: Math.max(size.x, size.y, size.z) * 0.025,
    coordinateSystem:
      'Y up; screen x right, y down; screenBounds are projected boxes and may be occluded',
    warnings: rt.isolateActivePiece ? ['Only the active piece is visible'] : []
  }
}

/** Read the real composited GPU targets; ignore unused UV space. Explicit, not every stroke. */
export function inspectPiece(rt: ViewportRuntime, index: number): unknown {
  const piece = rt.pieces[index],
    stack = piece.stack,
    renderer = rt.sceneHandle!.renderer
  stack.recomposite()
  const coverage = stack.coverageTarget()!,
    size = stack.textureSize,
    count = size * size
  const mask = readTargetRgba(renderer, coverage)
  const height = stack.channelTarget('height'),
    orm = stack.ormMapTarget()
  const heights = height ? new Uint8Array(count * 4) : null,
    materials = orm ? new Uint8Array(count * 4) : null
  if (height && heights) {
    renderer.readRenderTargetPixels(height, 0, 0, size, size, heights)
  }
  if (orm && materials) {
    renderer.readRenderTargetPixels(orm, 0, 0, size, size, materials)
  }
  let uvTexels = 0,
    nonzero = 0,
    clipped = 0,
    min = 65535,
    max = 0,
    sum = 0,
    rough = 0,
    metal = 0
  const distinct = new Set<number>()
  for (let i = 0; i < count; i++) {
    if (mask[i * 4] < 128) {
      continue
    }
    uvTexels++
    const code = heights ? heights[i * 4] * 256 + heights[i * 4 + 1] : 32768
    min = Math.min(min, code)
    max = Math.max(max, code)
    sum += code - 32768
    distinct.add(code)
    if (Math.abs(code - 32768) > 1) {
      nonzero++
    }
    if (code === 0 || code === 65535) {
      clipped++
    }
    rough += materials ? materials[i * 4 + 1] / 255 : 1
    metal += materials ? materials[i * 4 + 2] / 255 : 0
  }
  const n = Math.max(1, uvTexels),
    warnings: string[] = []
  if (!uvTexels) {
    warnings.push('No covered UV texels')
  }
  if (clipped) {
    warnings.push('Height reached its storage limit')
  }
  if (rough / n < 0.65) {
    warnings.push('Average roughness is low for matte impasto')
  }
  if ((index === rt.activePieceIndex && brush.selectedFaces().size) || stack.pixelSelection) {
    warnings.push('Selection restricts painting')
  }
  return {
    index,
    name: piece.name,
    textureSize: size,
    uvTexels,
    uvOccupancy: uvTexels / count,
    height: {
      min: (min - 32768) / 32767,
      max: (max - 32768) / 32767,
      mean: sum / n / 32767,
      distinctValues: distinct.size,
      nonzeroTexels: nonzero,
      nonzeroFraction: nonzero / n,
      clippedTexels: clipped,
      units: 'model units; UV-area weighted'
    },
    material: { meanRoughness: rough / n, meanMetalness: metal / n },
    warnings
  }
}

export function surfaceSample(rt: ViewportRuntime, index: number, uv: THREE.Vector2): unknown {
  const stack = rt.pieces[index].stack,
    size = stack.textureSize
  const x = THREE.MathUtils.clamp(Math.floor(uv.x * size), 0, size - 1),
    y = THREE.MathUtils.clamp(Math.floor(uv.y * size), 0, size - 1)
  const pixel = new Uint8Array(4),
    height = stack.channelTarget('height')
  let worldHeight = 0
  if (height) {
    rt.sceneHandle!.renderer.readRenderTargetPixels(height, x, y, 1, 1, pixel)
    worldHeight = (pixel[0] * 256 + pixel[1] - 32768) / 32767
  }
  return { height: worldHeight, units: 'model units', texel: [x, y] }
}
