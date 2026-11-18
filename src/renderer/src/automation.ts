import { sceneFeedback, inspectPiece, pieceBounds, surfaceSample } from './automationFeedback'
import * as THREE from 'three'
import { brush, setRadius, setSpacing, setOpacity } from './paint/brush'
import { brushPresets } from './paint/brushPresets'
import {
  onPointerDown,
  onPointerMove,
  onPointerUp,
  pieceHitFromEvent
} from './viewport/viewportPointer'
import type { ViewportRuntime } from './viewport/viewportRuntime'
import type { ViewportHandle } from './viewport/viewportTypes'
import type { TextureSize } from './paint/paintEngine'
import type { ToolMode } from './paint/brush'
import type { ChannelViewMode } from './viewport/viewportTypes'
import { PAINT_CHANNELS, type PaintChannel } from './paint/channels'

let runtime: ViewportRuntime | undefined
export function registerAutomationViewport(rt: ViewportRuntime): void {
  runtime = rt
}

interface Context {
  ready: () => boolean
  viewport: () => ViewportHandle | undefined
  project: () => {
    name: string
    modelPath: string | null
    projectPath: string | null
    dirty: boolean
  }
  openModel: (path: string, size: TextureSize) => Promise<void>
  openProject: (path: string, modelPath?: string) => Promise<void>
  saveProject: (path: string) => Promise<boolean>
  setTool: (tool: ToolMode) => void
  closeWelcome: () => void
}

const number = (value: unknown, min: number, max: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be ${min}..${max}`)
  }
  return value
}
const vector = (value: unknown, label: string): THREE.Vector3 => {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${label} must be [x,y,z]`)
  }
  return new THREE.Vector3(
    ...(value.map((v) => number(v, -1e6, 1e6, label)) as [number, number, number])
  )
}

type SurfacePoint = { clientX: number; clientY: number; pressure: number }
function* interpolate(points: SurfacePoint[]): Generator<SurfacePoint> {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i]
    const steps = Math.max(
      1,
      Math.min(256, Math.ceil(Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) / 4))
    )
    for (let j = 1; j <= steps; j++) {
      const t = j / steps
      yield {
        clientX: a.clientX + (b.clientX - a.clientX) * t,
        clientY: a.clientY + (b.clientY - a.clientY) * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t
      }
    }
  }
}

/** Stable production API, available only when the main process opts in. */
export function installMeshcoatAutomation(ctx: Context): () => void {
  const current = (): { rt: ViewportRuntime; h: ViewportHandle } => {
    const h = ctx.viewport()
    if (
      !runtime?.sceneHandle ||
      !runtime.canvasRef ||
      !h ||
      !ctx.ready() ||
      !brushPresets.ready()
    ) {
      throw new Error('MeshCoat is still initializing')
    }
    return { rt: runtime, h }
  }
  let restoreCapture: (() => void) | undefined
  const state = (): unknown => {
    const { rt, h } = current(),
      rect = rt.canvasRef!.getBoundingClientRect(),
      scene = rt.sceneHandle!
    return {
      project: ctx.project(),
      scene: sceneFeedback(rt),
      viewMode: h.getViewMode(),
      pieces: h.pieces(),
      activePiece: h.activePieceIndex(),
      channels: h.paintedChannels(),
      layers: rt.layerStack?.layers.map((l) => ({
        id: l.id,
        name: l.name,
        opacity: l.opacity,
        visible: l.visible,
        isMask: !!l.isMask
      })),
      brush: {
        preset: brushPresets.active()?.id,
        color: brush.color(),
        radius: brush.radius(),
        opacity: brush.opacity(),
        spacing: brush.spacing(),
        height: brush.heightAmount(),
        normalStrength: brush.normalStrength(),
        roughness: brush.roughnessValue(),
        channels: brush.channelEnabled(),
        radiusRange: brush.radiusRange(),
        rotation: brush.brushRotation(),
        followStroke: brush.angleFollowStroke(),
        angleJitter: brush.angleJitter(),
        sizeJitter: brush.sizeJitter()
      },
      camera: {
        position: scene.camera.position.toArray(),
        target: scene.controls.target.toArray()
      },
      viewport: { width: Math.round(rect.width), height: Math.round(rect.height) },
      canUndo: h.canUndo(),
      canRedo: h.canRedo()
    }
  }
  const point = (p: unknown): { clientX: number; clientY: number; pressure: number } => {
    if (!p || typeof p !== 'object') {
      throw new Error('Invalid point')
    }
    const value = p as Record<string, unknown>,
      { rt } = current(),
      r = rt.canvasRef!.getBoundingClientRect()
    return {
      clientX: r.x + number(value.x, 0, 1, 'x') * r.width,
      clientY: r.y + number(value.y, 0, 1, 'y') * r.height,
      pressure: value.pressure === undefined ? 1 : number(value.pressure, 0, 1, 'pressure')
    }
  }
  const invoke = async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    const { rt, h } = current()
    switch (command) {
      case 'status':
        return state()
      case 'inspect': {
        const index =
          args.pieceIndex === undefined
            ? h.activePieceIndex()
            : number(args.pieceIndex, 0, rt.pieces.length - 1, 'pieceIndex')
        if (!Number.isInteger(index)) {
          throw new Error('pieceIndex must be integer')
        }
        return inspectPiece(rt, index)
      }
      case 'select_piece': {
        const index = number(args.index, 0, rt.pieces.length - 1, 'index')
        if (!Number.isInteger(index)) {
          throw new Error('index must be integer')
        }
        h.setActivePiece(index)
        if (args.focus === true) {
          h.focusPiece(index)
        }
        if (typeof args.isolate === 'boolean') {
          h.setIsolateActivePiece(args.isolate)
        }
        return state()
      }
      case 'brushes':
        return brushPresets.packs().map((p) => ({
          name: p.packName,
          brushes: p.brushes.map((b) => ({
            id: b.id,
            name: b.name,
            spacing: b.spacing,
            height: !!b.authoredHeight
          }))
        }))
      case 'set_brush': {
        if (args.preset !== undefined) {
          const preset = brushPresets
            .packs()
            .flatMap((p) => p.brushes)
            .find((b) => b.id === args.preset)
          if (!preset) {
            throw new Error('Unknown preset; use meshcoat_brushes')
          }
          brushPresets.select(preset)
        }
        if (args.channels !== undefined) {
          if (
            !Array.isArray(args.channels) ||
            args.channels.some((c) => !PAINT_CHANNELS.includes(c))
          ) {
            throw new Error('Invalid channels')
          }
          PAINT_CHANNELS.forEach((c) =>
            brush.setChannelEnabled(c, (args.channels as string[]).includes(c))
          )
        }
        if (args.color !== undefined) {
          if (typeof args.color !== 'string' || !/^#[\da-f]{6}$/i.test(args.color)) {
            throw new Error('Use #RRGGBB')
          }
          brush.setColor(args.color)
        }
        if (args.radius !== undefined) {
          setRadius(number(args.radius, brush.radiusRange().min, brush.radiusRange().max, 'radius'))
        }
        if (args.spacing !== undefined) {
          setSpacing(number(args.spacing, 0.02, 2, 'spacing'))
        }
        if (args.opacity !== undefined) {
          setOpacity(number(args.opacity, 0, 1, 'opacity'))
        }
        if (args.height !== undefined) {
          brush.setHeightAmount(number(args.height, -0.06, 0.06, 'height'))
        }
        if (args.normalStrength !== undefined) {
          brush.setNormalStrength(number(args.normalStrength, -4, 4, 'normalStrength'))
        }
        if (args.roughness !== undefined) {
          brush.setRoughnessValue(number(args.roughness, 0, 1, 'roughness'))
        }
        if (args.rotation !== undefined) {
          brush.setBrushRotation(number(args.rotation, -360, 360, 'rotation'))
        }
        if (args.followStroke !== undefined) {
          brush.setAngleFollowStroke(args.followStroke === true)
        }
        if (args.angleJitter !== undefined) {
          brush.setAngleJitter(number(args.angleJitter, 0, 1, 'angleJitter'))
        }
        if (args.sizeJitter !== undefined) {
          brush.setSizeJitter(number(args.sizeJitter, 0, 1, 'sizeJitter'))
        }
        // Wait for the chosen real tip to finish decoding before the next command.
        const deadline = performance.now() + 15000
        while (
          brush.tipTexturePath() &&
          (rt.brushTipTexture?.image as HTMLImageElement | undefined)?.src !==
            brush.tipTexturePath()
        ) {
          if (performance.now() > deadline) {
            throw new Error('Brush tip did not finish loading')
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        return state()
      }
      case 'open': {
        if (ctx.project().dirty && args.allowDiscard !== true) {
          throw new Error(
            'Unsaved paint: save a project first, or explicitly set allowDiscard=true'
          )
        }
        if (typeof args.path !== 'string') {
          throw new Error('Specify path')
        }
        if (args.path.toLowerCase().endsWith('.meshcoat')) {
          await ctx.openProject(
            args.path,
            typeof args.modelPath === 'string' ? args.modelPath : undefined
          )
        } else {
          const size =
            args.resolution === undefined ? 1024 : number(args.resolution, 512, 4096, 'resolution')
          if (![512, 1024, 2048, 4096].includes(size)) {
            throw new Error('Resolution must be 512,1024,2048,4096')
          }
          await ctx.openModel(args.path, size as TextureSize)
        }
        ctx.closeWelcome()
        return state()
      }
      case 'camera': {
        if (args.lighting !== undefined) {
          if (!['neutral', 'flat', 'outdoor', 'warm', 'cool'].includes(args.lighting as string)) {
            throw new Error('Invalid lighting')
          }
          h.setLightingMode(args.lighting as 'neutral')
        }
        if (typeof args.preset === 'string') {
          const directions: Record<string, number[]> = {
            front: [0, 0, 1],
            back: [0, 0, -1],
            left: [-1, 0, 0],
            right: [1, 0, 0],
            top: [0.001, 1, 0],
            isometric: [1, 0.8, 1]
          }
          if (!directions[args.preset]) {
            throw new Error('Unknown camera preset')
          }
          const box = new THREE.Box3()
          if (typeof args.pieceIndex === 'number') {
            const index = number(args.pieceIndex, 0, rt.pieces.length - 1, 'pieceIndex')
            number(index % 1, 0, 0, 'pieceIndex fraction')
            box.copy(pieceBounds(rt, index))
          } else {
            rt.pieces.forEach((_, i) => box.union(pieceBounds(rt, i)))
          }
          const sphere = box.getBoundingSphere(new THREE.Sphere()),
            camera = rt.sceneHandle!.camera
          const distance =
            ((sphere.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.15) /
            (Math.min(1, camera.aspect) *
              (args.zoom === undefined ? 1 : number(args.zoom, 0.4, 3, 'zoom')))
          const dir = new THREE.Vector3(
            ...(directions[args.preset] as [number, number, number])
          ).normalize()
          rt.sceneHandle!.controls.setView(
            sphere.center.clone().addScaledVector(dir, distance),
            sphere.center
          )
        } else if (args.frame === true) {
          h.focusModel()
        } else if (args.position !== undefined || args.target !== undefined) {
          const position = vector(args.position, 'position'),
            target = vector(args.target, 'target')
          if (position.distanceTo(target) < 0.001) {
            throw new Error('Camera position and target must differ')
          }
          rt.sceneHandle!.controls.setView(position, target)
        }
        rt.sceneHandle!.camera.updateMatrixWorld(true)
        return state()
      }
      case 'probe': {
        const sample = (p: unknown): unknown => {
          const hit = pieceHitFromEvent(rt, point(p))
          if (!hit) {
            return { hit: false }
          }
          const index = rt.pieces.findIndex((piece) => piece.mesh === hit.mesh)
          return {
            hit: true,
            piece: index,
            world: hit.point.toArray(),
            normal: hit.normal.toArray(),
            uv: hit.uv.toArray(),
            face: hit.faceIndex,
            sample: surfaceSample(rt, index, hit.uv)
          }
        }
        if (args.points !== undefined) {
          if (!Array.isArray(args.points) || args.points.length < 1 || args.points.length > 128) {
            throw new Error('Use 1..128 probe points')
          }
          return { samples: args.points.map(sample) }
        }
        return sample(args)
      }
      case 'stroke': {
        if (!Array.isArray(args.points) || args.points.length < 1 || args.points.length > 256) {
          throw new Error('Use 1..256 normalized viewport points')
        }
        const points = args.points.map(point)
        ctx.setTool(args.tool === 'eraser' ? 'eraser' : 'brush')
        const before = rt.pieces.map((p) => p.stack.activePaintEngine?.contentVersion)
        let samples = 0,
          hits = 0
        const hitPieces = new Set<number>()
        const track = (p: SurfacePoint): void => {
          samples++
          const hit = pieceHitFromEvent(rt, p)
          if (hit) {
            hits++
            hitPieces.add(rt.pieces.findIndex((piece) => piece.mesh === hit.mesh))
          }
        }
        track(points[0])
        const event = (p: (typeof points)[number], type: string, buttons: number): PointerEvent =>
          new PointerEvent(type, {
            ...p,
            pointerId: 9001,
            pointerType: args.pressure === true ? 'pen' : 'mouse',
            button: 0,
            buttons,
            bubbles: true
          })
        try {
          onPointerDown(rt, event(points[0], 'pointerdown', 1))
          for (const p of interpolate(points)) {
            track(p)
            onPointerMove(rt, event(p, 'pointermove', 1))
          }
        } finally {
          onPointerUp(rt, event(points[points.length - 1], 'pointerup', 0))
        }
        return {
          painted: rt.pieces.some(
            (p, i) => p.stack.activePaintEngine?.contentVersion !== before[i]
          ),
          feedback: {
            sampledPoints: samples,
            surfaceHits: hits,
            misses: samples - hits,
            hitPieces: [...hitPieces],
            changedPieces: rt.pieces.flatMap((p, i) =>
              p.stack.activePaintEngine?.contentVersion !== before[i] ? [i] : []
            ),
            note: 'Ray hits describe the path; changedPieces report engine writes. Inspect/screenshot verifies changed texels and material appearance.'
          },
          state: state()
        }
      }
      case 'add_layer': {
        if (!rt.layerStack) {
          throw new Error('No model')
        }
        if (typeof args.name !== 'string' || args.name.length > 120) {
          throw new Error('Specify layer name')
        }
        rt.layerStack.addLayer(args.name)
        rt.props.onLayersChanged?.()
        return state()
      }
      case 'fill':
        h.fillActive()
        return state()
      case 'history': {
        if (args.action === 'undo') {
          h.undo()
        } else if (args.action === 'redo') {
          h.redo()
        } else {
          throw new Error('Use undo or redo')
        }
        return state()
      }
      case 'save_project': {
        if (typeof args.path !== 'string' || !(await ctx.saveProject(args.path))) {
          throw new Error('Project save failed')
        }
        return state()
      }
      case 'export': {
        const channels =
          args.channels === undefined
            ? ['albedo', 'normal', 'roughness', 'height', 'orm']
            : args.channels
        if (
          !Array.isArray(channels) ||
          channels.some(
            (c) => !['albedo', 'normal', 'roughness', 'height', 'orm', 'metalness'].includes(c)
          )
        ) {
          throw new Error('Invalid export channels')
        }
        const index =
          args.pieceIndex === undefined
            ? h.activePieceIndex()
            : number(args.pieceIndex, 0, rt.pieces.length - 1, 'pieceIndex')
        if (!Number.isInteger(index)) {
          throw new Error('pieceIndex must be an integer')
        }
        const maps: { channel: string; suffix: string; dataUrl: string }[] = []
        for (const channel of channels) {
          const dataUrl =
            channel === 'height'
              ? await h.exportHeightPng16(index)
              : channel === 'albedo'
                ? h.exportBaseColorPng(index)
                : channel === 'orm'
                  ? h.exportOrmPng(index)
                  : h.exportChannelPng(channel as PaintChannel, index)
          if (dataUrl) {
            maps.push({ channel, suffix: channel, dataUrl })
          }
        }
        return maps
      }
      case 'export_godot': {
        const pieces: {
          index: number
          name: string
          maps: { channel: string; dataUrl: string }[]
        }[] = []
        for (let i = 0; i < rt.pieces.length; i++) {
          const maps: { channel: string; dataUrl: string }[] = []
          for (const channel of ['albedo', 'normal', 'roughness', 'height', 'metalness']) {
            let dataUrl =
              channel === 'height'
                ? await h.exportHeightPng16(i)
                : channel === 'albedo'
                  ? h.exportBaseColorPng(i)
                  : h.exportChannelPng(channel as PaintChannel, i)
            if (!dataUrl && ['albedo', 'normal', 'roughness'].includes(channel)) {
              const canvas = document.createElement('canvas')
              canvas.width = canvas.height = rt.pieces[i].stack.textureSize
              const c = canvas.getContext('2d')!
              c.fillStyle =
                channel === 'normal' ? '#8080ff' : channel === 'roughness' ? '#ffffff' : '#ffffff'
              c.fillRect(0, 0, canvas.width, canvas.height)
              dataUrl = canvas.toDataURL('image/png')
            }
            if (dataUrl) {
              maps.push({ channel, dataUrl })
            }
          }
          pieces.push({ index: i, name: rt.pieces[i].name, maps })
        }
        return { modelPath: ctx.project().modelPath, pieces }
      }
      case 'restore_view':
        restoreCapture?.()
        restoreCapture = undefined
        return true
      case 'viewport_rect': {
        restoreCapture?.()
        const previous = h.getViewMode(),
          hidden: { object: THREE.Object3D; visible: boolean }[] = []
        const hide = (object: THREE.Object3D | undefined): void => {
          if (object) {
            hidden.push({ object, visible: object.visible })
            object.visible = false
          }
        }
        if (args.clean !== false) {
          hide(rt.gizmoHandle?.group)
          hide(rt.gizmoHandle?.mirrorGroup)
          hide(rt.activePieceBox)
          hide(rt.hoverPieceBox)
          rt.sceneHandle!.scene.children.filter((o) => o.type === 'GridHelper').forEach(hide)
          rt.pieces.forEach((p) => {
            hide(p.hoverFaceMesh)
            hide(p.hoverFillMesh)
            hide(p.highlightMesh)
            hide(p.selectionFillMesh)
          })
        }
        if (args.mode !== undefined) {
          if (
            !['material', 'baseColor', 'normal', 'roughness', 'height'].includes(
              args.mode as string
            )
          ) {
            throw new Error('Invalid view mode')
          }
          h.setViewMode(args.mode as ChannelViewMode)
        }
        restoreCapture = () => {
          h.setViewMode(previous)
          hidden.forEach(({ object, visible }) => {
            object.visible = visible
          })
        }
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
        const r = rt.canvasRef!.getBoundingClientRect()
        return {
          x: Math.ceil(r.x),
          y: Math.ceil(r.y),
          width: Math.floor(r.width),
          height: Math.floor(r.height),
          feedback: state()
        }
      }
      default:
        throw new Error('Unknown automation command')
    }
  }
  const surface = { invoke }
  Object.assign(window, { __meshcoatMcp: surface })
  return () => {
    if ((window as unknown as { __meshcoatMcp?: unknown }).__meshcoatMcp === surface) {
      delete (window as unknown as { __meshcoatMcp?: unknown }).__meshcoatMcp
    }
  }
}
