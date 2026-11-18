import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import fs from 'node:fs'

const out = new URL('../impasto/models/', import.meta.url)
fs.mkdirSync(out, { recursive: true })
function saveGlb(name, geometry) {
  const attributes = {}
  const accessors = []
  const bufferViews = []
  const parts = []
  let offset = 0
  for (const [key, attr] of Object.entries(geometry.attributes)) {
    if (!['position', 'normal', 'uv'].includes(key)) continue
    const bytes = Buffer.from(attr.array.buffer, attr.array.byteOffset, attr.array.byteLength)
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target: 34962 })
    parts.push(bytes)
    offset += bytes.length
    const a = {
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count: attr.count,
      type: { 2: 'VEC2', 3: 'VEC3' }[attr.itemSize]
    }
    if (key === 'position') {
      geometry.computeBoundingBox()
      a.min = geometry.boundingBox.min.toArray()
      a.max = geometry.boundingBox.max.toArray()
    }
    attributes[{ position: 'POSITION', normal: 'NORMAL', uv: 'TEXCOORD_0' }[key]] = accessors.length
    accessors.push(a)
  }
  const gltf = {
    asset: { version: '2.0', generator: 'MeshCoat MeshCoat test fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes, material: 0 }] }],
    materials: [
      {
        name: 'Matte test ground',
        pbrMetallicRoughness: {
          baseColorFactor: [0.18, 0.2, 0.13, 1],
          metallicFactor: 0,
          roughnessFactor: 0.9
        }
      }
    ],
    buffers: [{ byteLength: offset }],
    bufferViews,
    accessors
  }
  let json = Buffer.from(JSON.stringify(gltf))
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 32)])
  const bin = Buffer.concat(parts)
  const header = Buffer.alloc(20)
  header.writeUInt32LE(0x46546c67)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(28 + json.length + bin.length, 8)
  header.writeUInt32LE(json.length, 12)
  header.writeUInt32LE(0x4e4f534a, 16)
  const bh = Buffer.alloc(8)
  bh.writeUInt32LE(bin.length)
  bh.writeUInt32LE(0x004e4942, 4)
  fs.writeFileSync(new URL(name + '.glb', out), Buffer.concat([header, json, bh, bin]))
}
const trunk = new THREE.CylinderGeometry(0.19, 0.31, 1.85, 7, 1, false).toNonIndexed()
trunk.translate(0, 0.925, 0)
const crowns = [
  [-0.55, 2.05, 0, 1.08],
  [0.52, 2.25, -0.04, 1.05],
  [0.02, 2.99, 0.03, 1.02]
].map(([x, y, z, r]) => {
  const g = new THREE.IcosahedronGeometry(r, 0)
  g.scale(1, 0.91, 0.85)
  g.translate(x, y, z)
  return g
})
const tree = mergeGeometries([trunk, ...crowns])
tree.deleteAttribute('uv')
tree.computeVertexNormals()
const tris = tree.attributes.position.count / 3
const grid = Math.ceil(Math.sqrt(tris))
const uv = []
for (let f = 0; f < tris; f++) {
  const x = f % grid,
    y = Math.floor(f / grid),
    pad = 0.055
  // Raw GLB UVs use a top-left image origin; arbitrary rotated islands exercise seams.
  const corners = [
    [pad, pad],
    [1 - pad, pad],
    [pad, 1 - pad]
  ]
  for (const [a, b] of corners) uv.push((x + a) / grid, (y + b) / grid)
}
tree.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
saveGlb('test_tree', tree)
// Coplanar seam test: left island regular, right island rotated 90 degrees.
const panel = new THREE.BufferGeometry()
panel.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(
    [
      -1, -1, 0, 0, -1, 0, 0, 1, 0, -1, -1, 0, 0, 1, 0, -1, 1, 0, 0, -1, 0, 1, -1, 0, 1, 1, 0, 0,
      -1, 0, 1, 1, 0, 0, 1, 0
    ],
    3
  )
)
panel.setAttribute(
  'uv',
  new THREE.Float32BufferAttribute(
    [
      0.05, 0.95, 0.45, 0.95, 0.45, 0.05, 0.05, 0.95, 0.45, 0.05, 0.05, 0.05, 0.55, 0.05, 0.55,
      0.95, 0.95, 0.95, 0.55, 0.05, 0.95, 0.95, 0.95, 0.05
    ],
    2
  )
)
panel.computeVertexNormals()
saveGlb('seam_panel', panel)
console.log(
  `Tree: ${tris} triangles, ${grid}x${grid} separated UV islands; seam panel: 4 triangles.`
)
