import * as THREE from 'three'

// Signed model-space height, -1..+1 model units. Lossless 16-bit scalar
// packed into RG of RGBA8 so undo/project PNGs preserve every bit.
export const HEIGHT_GLSL = /* glsl */ `
float readHeight(vec4 p) {
  return p.a < 0.5 ? 0.0 : (dot(p.rg, vec2(65280.0,255.0)) - 32768.0) / 32767.0;
}
vec4 packHeight(float h) {
  float v = floor(clamp(h * 32767.0 + 32768.0, 0.0, 65535.0) + 0.5);
  return vec4(floor(v / 256.0) / 255.0, mod(v,256.0) / 255.0, 0.0, 1.0);
}
`

export function createHeightNormalMaterial(size: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      tHeight: { value: null },
      tCoverage: { value: null },
      uTexel: { value: new THREE.Vector2(1 / size, 1 / size) }
    },
    vertexShader: /* glsl */ `
      attribute vec3 aWorldPosition;
      attribute vec3 aWorldNormal;
      attribute vec3 aSurfaceTangent;
      attribute vec3 aSurfaceBitangent;
      varying vec3 vP; varying vec3 vN; varying vec3 vT; varying vec3 vB; varying vec2 vUv;
      void main() {
        vP=aWorldPosition; vN=aWorldNormal; vT=aSurfaceTangent; vB=aSurfaceBitangent; vUv=uv;
        gl_Position=vec4(position.xy,0.0,1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tHeight; uniform sampler2D tCoverage; uniform vec2 uTexel;
      varying vec3 vP; varying vec3 vN; varying vec3 vT; varying vec3 vB; varying vec2 vUv;
      ${HEIGHT_GLSL}
      void main() {
        vec2 sx=vec2(uTexel.x,0.0),sy=vec2(0.0,uTexel.y);
        float hc=readHeight(texture2D(tHeight,vUv));
        float xp=readHeight(texture2D(tHeight,vUv+sx)),xm=readHeight(texture2D(tHeight,vUv-sx));
        float yp=readHeight(texture2D(tHeight,vUv+sy)),ym=readHeight(texture2D(tHeight,vUv-sy));
        bool cxp=texture2D(tCoverage,vUv+sx).r>0.5,cxm=texture2D(tCoverage,vUv-sx).r>0.5;
        bool cyp=texture2D(tCoverage,vUv+sy).r>0.5,cym=texture2D(tCoverage,vUv-sy).r>0.5;
        float dx=cxp && cxm ? (xp-xm)*0.5 : cxp ? xp-hc : cxm ? hc-xm : 0.0;
        float dy=cyp && cym ? (yp-ym)*0.5 : cyp ? yp-hc : cym ? hc-ym : 0.0;
        vec3 ex=dFdx(vP), ey=dFdy(vP);
        float aa=dot(ex,ex), bb=dot(ex,ey), cc=dot(ey,ey);
        float det=max(aa*cc-bb*bb,1e-20);
        vec3 g=((dx*cc-dy*bb)*ex+(dy*aa-dx*bb)*ey)/det;
        vec3 n=normalize(normalize(vN)-g);
        vec3 ts=normalize(vec3(dot(n,normalize(vT)),dot(n,normalize(vB)),max(dot(n,normalize(vN)),0.001)));
        gl_FragColor=vec4(ts*0.5+0.5,1.0);
      }
    `,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide
  })
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of bytes) {
    crc ^= b
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + 12),
    view = new DataView(result.buffer)
  view.setUint32(0, data.length)
  result.set(new TextEncoder().encode(type), 4)
  result.set(data, 8)
  view.setUint32(data.length + 8, crc32(result.subarray(4, data.length + 8)))
  return result
}
/** True 16-bit grayscale PNG; no Canvas2D/8-bit conversion in this path. */
export async function height16Png(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget
): Promise<string> {
  const w = target.width,
    h = target.height,
    rgba = new Uint8Array(w * h * 4)
  renderer.readRenderTargetPixels(target, 0, 0, w, h, rgba)
  const scan = new Uint8Array(h * (1 + w * 2))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((h - 1 - y) * w + x) * 4,
        dst = y * (1 + w * 2) + 1 + x * 2
      scan[dst] = rgba[src]
      scan[dst + 1] = rgba[src + 1]
    }
  }
  const header = new Uint8Array(13),
    v = new DataView(header.buffer)
  v.setUint32(0, w)
  v.setUint32(4, h)
  header[8] = 16
  header[9] = 0
  const compressed = new Uint8Array(
    await new Response(
      new Blob([scan]).stream().pipeThrough(new CompressionStream('deflate'))
    ).arrayBuffer()
  )
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk(
      'tEXt',
      new TextEncoder().encode(
        'HeightMapping\0world_height=(sample-32768)/32767; model units; zero=32768'
      )
    ),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array())
  ]
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    result.set(p, offset)
    offset += p.length
  }
  let binary = ''
  for (let i = 0; i < result.length; i += 8192) {
    binary += String.fromCharCode(...result.subarray(i, i + 8192))
  }
  return 'data:image/png;base64,' + btoa(binary)
}
