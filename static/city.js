// A stylised night-time New York City: Manhattan's street grid, landmark towers,
// rivers, bridges and live traffic. Each AI project is rendered as its own tower
// in a dedicated district on the West Side (around Hudson Yards).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

// Colours are written in display space, so colour management is turned off.
THREE.ColorManagement.enabled = false;

const AVENUE = 2.8; // distance between avenues (x)
const STREET = 0.8; // distance between streets (z)
const FOG_COLOR = new THREE.Color(0x0a0d18);
const FOG_DENSITY = 0.0052;

export const STATUS_COLORS = {
  draft: 0x8a93a6,
  training: 0xffb547,
  trained: 0x5ee6a0,
  failed: 0xff4d3d,
};

// Manhattan outline: z runs south (+) to north (-), with half-width and centre x.
const ISLAND = [
  [-112, 0, 2],
  [-100, 7, 3],
  [-80, 12, 2],
  [-60, 14, 1],
  [-20, 15, 0],
  [20, 15, -1],
  [50, 14, 0],
  [70, 15, 0],
  [85, 12, -1],
  [95, 7, -3],
  [101, 0, -4],
];

function islandAt(z) {
  if (z <= ISLAND[0][0] || z >= ISLAND[ISLAND.length - 1][0]) return null;
  for (let i = 0; i < ISLAND.length - 1; i++) {
    const [z0, w0, c0] = ISLAND[i];
    const [z1, w1, c1] = ISLAND[i + 1];
    if (z >= z0 && z <= z1) {
      const t = (z - z0) / (z1 - z0);
      return { hw: w0 + (w1 - w0) * t, c: c0 + (c1 - c0) * t };
    }
  }
  return null;
}

function insideManhattan(x, z, margin = 0) {
  const s = islandAt(z);
  return !!s && Math.abs(x - s.c) < s.hw - margin;
}

// Deterministic random so the skyline is the same on every visit.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gauss = (dx, dz, sigma) => Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma));

const FOG_GLSL = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  vec3 applyFog(vec3 col, float depth) {
    float f = 1.0 - exp(-uFogDensity * uFogDensity * depth * depth);
    return mix(col, uFogColor, clamp(f, 0.0, 1.0));
  }
`;

const fogUniforms = () => ({
  uFogColor: { value: FOG_COLOR },
  uFogDensity: { value: FOG_DENSITY },
});

function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

// ---------------------------------------------------------------------------
// Buildings: one instanced mesh with procedural lit windows.
// ---------------------------------------------------------------------------

function buildingMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, ...fogUniforms() },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying float vSeed;
      varying float vDepth;
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        vSeed = aSeed;
        vec4 mv = viewMatrix * wp;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uLights;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying float vSeed;
      varying float vDepth;
      ${FOG_GLSL}
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec3 n = normalize(vNormalW);
        vec3 facade = vec3(0.028, 0.032, 0.046) * (0.75 + 0.5 * vSeed);
        vec3 col = facade;
        if (n.y > 0.5) {
          col = vec3(0.018, 0.02, 0.028);
        } else {
          float u = abs(n.x) > 0.5 ? vWorld.z : vWorld.x;
          vec2 g = vec2(u / 0.11, vWorld.y / 0.16);
          vec2 cell = floor(g);
          vec2 f = fract(g);
          float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.22, f.y) * step(f.y, 0.78);
          float side = n.x * 3.0 + n.z * 7.0;
          float r = hash(cell + vSeed * 91.7 + side);
          float ratio = 0.22 + 0.3 * vSeed;
          float lit = step(1.0 - ratio, r);
          // A few windows switch on and off over time.
          float flick = step(0.985, hash(cell * 1.3 + floor(uTime * 0.15 + r * 10.0)));
          lit = abs(lit - flick);
          vec3 warm = mix(vec3(1.0, 0.66, 0.32), vec3(1.0, 0.86, 0.6), hash(cell * 1.7));
          vec3 cool = vec3(0.62, 0.76, 1.0);
          vec3 wc = mix(warm, cool, step(0.86, hash(cell * 2.3 + vSeed)));
          vec3 detail = facade + win * (lit * wc * (0.45 + 0.85 * hash(cell * 5.1)) + (1.0 - lit) * vec3(0.012, 0.018, 0.03));
          // Far away the window grid becomes sub-pixel; fade to its average colour.
          vec3 average = facade + vec3(1.0, 0.74, 0.45) * ratio * 0.36 * 0.75;
          float fw = max(fwidth(g.x), fwidth(g.y));
          col = mix(detail, average, smoothstep(0.35, 0.9, fw));
          col *= uLights;
          col += vec3(1.0, 0.55, 0.25) * 0.22 * exp(-vWorld.y * 3.5);
        }
        gl_FragColor = vec4(applyFog(col, vDepth), 1.0);
      }
    `,
  });
}

function generateBuildings(rand, exclusions) {
  const boxes = []; // [x, z, w, d, h, yBase, seed]
  const excluded = (x, z) =>
    exclusions.some((r) => x > r[0] && x < r[1] && z > r[2] && z < r[3]);

  const addTower = (x, z, w, d, h, seed) => {
    boxes.push([x, z, w, d, h, 0, seed]);
    // Wedding-cake setbacks on tall Manhattan towers.
    if (h > 5 && rand() < 0.7) {
      const h2 = h * (0.25 + rand() * 0.35);
      boxes.push([x, z, w * 0.68, d * 0.72, h2, h, seed]);
      if (h > 8 && rand() < 0.5) boxes.push([x, z, w * 0.4, d * 0.45, h2 * 0.4, h + h2, seed]);
    }
  };

  // Manhattan
  for (let z = -112; z < 101; z += STREET) {
    for (let x = -18 * AVENUE; x < 18 * AVENUE; x += AVENUE) {
      const bz0 = z + 0.1;
      const bz1 = z + STREET - 0.1;
      let cursor = x + 0.25;
      const end = x + AVENUE - 0.25;
      while (cursor < end - 0.2) {
        const w = Math.min(end - cursor, 0.4 + rand() * 0.7);
        const cx = cursor + w / 2;
        const cz = (bz0 + bz1) / 2;
        cursor += w + 0.05;
        if (!insideManhattan(cx, cz, 0.9) || excluded(cx, cz)) continue;

        const mid = gauss(cx - 0, cz - 15, 11);
        const down = gauss(cx + 3, cz - 88, 6.5);
        const uptown = cz < -5 ? 0.6 : 0;
        let h = 0.5 + rand() * 1.3 + uptown * rand() * 2;
        h += mid * (3 + rand() * 7) + down * (3.5 + rand() * 8);
        if (rand() < 0.03 && mid + down > 0.25) h += 4 + rand() * 5;
        const seed = rand();
        if (rand() < 0.35 || h > 4) {
          addTower(cx, cz, w, bz1 - bz0, h, seed);
        } else {
          const d = (bz1 - bz0) / 2 - 0.02;
          boxes.push([cx, bz0 + d / 2, w, d, h, 0, seed]);
          boxes.push([cx, bz1 - d / 2, w, d, h * (0.7 + rand() * 0.6), 0, rand()]);
        }
      }
    }
  }

  // Billionaires' Row: slender supertalls along 57th Street.
  [[-5, -3.2, 12.2], [-1.6, -2.4, 10.8], [3.8, -3.2, 11.5], [7.2, -1.6, 9.6]].forEach(([x, z, h]) =>
    boxes.push([x, z, 0.42, 0.42, h, 0, rand()]),
  );

  // New Jersey and Brooklyn/Queens waterfronts, sparser and lower.
  const outer = (x0, x1, z0, z1, shore, clusters) => {
    for (let z = z0; z < z1; z += 1.1) {
      for (let x = x0; x < x1; x += 1.4) {
        const dist = Math.abs(x - shore);
        if (rand() > 0.85 - dist * 0.012) continue;
        const w = 0.5 + rand() * 0.6;
        const d = 0.5 + rand() * 0.4;
        let h = 0.3 + rand() * 1.0;
        clusters.forEach(([cx, cz, s, amp]) => (h += gauss(x - cx, z - cz, s) * amp * (0.4 + rand())));
        boxes.push([x + 0.7, z + 0.55, w, d, h, 0, rand()]);
      }
    }
  };
  outer(-70, -28, -110, 130, -28, [[-33, 82, 6, 6], [-34, 25, 8, 2.5]]);
  outer(26, 75, -112, 140, 26, [[32, 96, 6, 5.5], [30, -6, 6, 5], [29, 62, 5, 2]]);
  outer(-26, 60, -190, -124, -124, []);

  return boxes;
}

function buildingMesh(boxes, uniforms) {
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const mesh = new THREE.InstancedMesh(geo, buildingMaterial(uniforms), boxes.length);
  const seeds = new Float32Array(boxes.length);
  const m = new THREE.Matrix4();
  boxes.forEach(([x, z, w, d, h, y, seed], i) => {
    m.makeScale(w, h, d);
    m.setPosition(x, y, z);
    mesh.setMatrixAt(i, m);
    seeds[i] = seed;
  });
  geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Ground, water, parks and sky
// ---------------------------------------------------------------------------

function landMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: fogUniforms(),
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying float vDepth;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mv = viewMatrix * wp;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying float vDepth;
      ${FOG_GLSL}
      void main() {
        vec3 col = vec3(0.016, 0.018, 0.026);
        float ax = abs(fract(vWorld.x / ${AVENUE.toFixed(2)}) - 0.0);
        ax = min(ax, 1.0 - ax) * ${AVENUE.toFixed(2)};
        float sz = fract(vWorld.z / ${STREET.toFixed(2)});
        sz = min(sz, 1.0 - sz) * ${STREET.toFixed(2)};
        float fa = fwidth(vWorld.x) * 1.5;
        float ave = 1.0 - smoothstep(0.04, 0.16 + fa, ax);
        float st = 1.0 - smoothstep(0.02, 0.06 + fa, sz);
        float lod = 1.0 - smoothstep(0.08, 0.5, fwidth(vWorld.z));
        col += vec3(1.0, 0.6, 0.26) * (ave * 0.5 + st * 0.16 * lod);
        gl_FragColor = vec4(applyFog(col, vDepth), 1.0);
      }
    `,
  });
}

function waterMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniforms, ...fogUniforms() },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying float vDepth;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mv = viewMatrix * wp;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vWorld;
      varying float vDepth;
      ${FOG_GLSL}
      float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 17853.13); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        vec2 p = vWorld.xz;
        float n = noise(p * vec2(0.9, 3.5) + vec2(uTime * 0.25, uTime * 0.05));
        n += 0.5 * noise(p * vec2(2.3, 7.0) - vec2(uTime * 0.4, 0.0));
        vec3 col = vec3(0.012, 0.02, 0.04);
        // City lights scattered on the ripples.
        float sparkle = smoothstep(1.18, 1.42, n);
        col += vec3(1.0, 0.62, 0.3) * sparkle * 0.55;
        col += vec3(0.02, 0.03, 0.06) * n;
        gl_FragColor = vec4(applyFog(col, vDepth), 1.0);
      }
    `,
  });
}

function shapeFromXZ(points) {
  // ShapeGeometry lies in XY; after rotating to the ground, shape y becomes -z.
  const shape = new THREE.Shape();
  points.forEach(([x, z], i) => (i ? shape.lineTo(x, -z) : shape.moveTo(x, -z)));
  return shape;
}

function landMesh(points, material, y = 0) {
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shapeFromXZ(points)), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  return mesh;
}

function manhattanOutline() {
  const east = [];
  const west = [];
  for (let z = ISLAND[0][0]; z <= ISLAND[ISLAND.length - 1][0]; z += 1) {
    const s = islandAt(z) || { hw: 0, c: z < 0 ? ISLAND[0][2] : ISLAND[ISLAND.length - 1][2] };
    east.push([s.c + s.hw, z]);
    west.unshift([s.c - s.hw, z]);
  }
  return [...east, ...west];
}

function skyDome() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, -0.1, 1.0);
        vec3 zenith = vec3(0.012, 0.016, 0.04);
        vec3 horizon = vec3(0.13, 0.075, 0.07);
        vec3 col = mix(horizon, zenith, pow(smoothstep(-0.02, 0.55, h), 0.6));
        col = mix(col, vec3(0.04, 0.05, 0.09), smoothstep(0.0, -0.1, vDir.y));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), mat);
}

function stars(rand) {
  const count = 1400;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(0.15 + rand() * 0.85);
    pos[i * 3] = 850 * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = 850 * Math.cos(phi);
    pos[i * 3 + 2] = 850 * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(
    geo,
    new THREE.PointsMaterial({ color: 0xcfd8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.7, fog: false }),
  );
}

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------

function addLandmarks(scene, boxes, rand, glow) {
  const lights = new THREE.Group();
  const sprite = (color, scale, x, y, z) => {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glow, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    s.scale.setScalar(scale);
    s.position.set(x, y, z);
    lights.add(s);
    return s;
  };
  const emissive = (color) => new THREE.MeshBasicMaterial({ color });

  // Empire State Building — 34th Street & Fifth Avenue
  const esb = [1.4, 25];
  boxes.push([esb[0], esb[1], 1.7, 1.0, 2.4, 0, 0.6]);
  boxes.push([esb[0], esb[1], 1.2, 0.75, 5.2, 2.4, 0.7]);
  boxes.push([esb[0], esb[1], 0.85, 0.58, 1.6, 7.6, 0.7]);
  const crown = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.9, 0.44).translate(0, 0.45, 0), emissive(0xffd27a));
  crown.position.set(esb[0], 9.2, esb[1]);
  scene.add(crown);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.22, 1.2, 8).translate(0, 0.6, 0), emissive(0xfff0d0));
  mast.position.set(esb[0], 10.1, esb[1]);
  scene.add(mast);
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.05, 1.8, 6).translate(0, 0.9, 0), emissive(0x9aa0b0));
  antenna.position.set(esb[0], 11.3, esb[1]);
  scene.add(antenna);
  const esbBeacon = sprite(0xff3b30, 1.2, esb[0], 13.15, esb[1]);

  // Chrysler Building — 42nd Street & Lexington Avenue
  const chr = [7.0, 15.2];
  boxes.push([chr[0], chr[1], 1.1, 0.9, 3.0, 0, 0.5]);
  boxes.push([chr[0], chr[1], 0.75, 0.75, 4.2, 3.0, 0.5]);
  for (let i = 0; i < 6; i++) {
    const r = 0.42 - i * 0.06;
    const arch = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 0.82, r, 0.32, 16, 1, true).translate(0, 0.16, 0),
      new THREE.MeshBasicMaterial({ color: 0xfff1d6, side: THREE.DoubleSide, transparent: true, opacity: 0.9 - i * 0.05 }),
    );
    arch.position.set(chr[0], 7.2 + i * 0.32, chr[1]);
    scene.add(arch);
  }
  const spire = new THREE.Mesh(new THREE.ConeGeometry(0.08, 1.6, 8).translate(0, 0.8, 0), emissive(0xe8ecf5));
  spire.position.set(chr[0], 9.1, chr[1]);
  scene.add(spire);

  // One World Trade Center — tapered square tower
  const wtc = [-6.6, 88];
  const wtcMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 1.05, 11.5, 4, 1).translate(0, 5.75, 0),
    new THREE.MeshStandardMaterial({ color: 0x0c1424, metalness: 0.95, roughness: 0.18, emissive: 0x0a1a36, emissiveIntensity: 1 }),
  );
  wtcMesh.rotation.y = Math.PI / 4;
  wtcMesh.position.set(wtc[0], 0, wtc[1]);
  scene.add(wtcMesh);
  const wtcEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(wtcMesh.geometry),
    new THREE.LineBasicMaterial({ color: 0x8fb7ff, transparent: true, opacity: 0.55 }),
  );
  wtcEdges.rotation.y = Math.PI / 4;
  wtcEdges.position.copy(wtcMesh.position);
  scene.add(wtcEdges);
  const wtcSpire = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.08, 3.6, 6).translate(0, 1.8, 0), emissive(0xdde6ff));
  wtcSpire.position.set(wtc[0], 11.5, wtc[1]);
  scene.add(wtcSpire);
  const wtcBeacon = sprite(0xffffff, 1.4, wtc[0], 15.2, wtc[1]);

  // Central Park with the reservoir
  const park = new THREE.Mesh(
    new THREE.PlaneGeometry(8.2, 55),
    new THREE.MeshBasicMaterial({ color: 0x07140d }),
  );
  park.rotation.x = -Math.PI / 2;
  park.position.set(0, 0.03, -32.5);
  scene.add(park);
  const reservoir = new THREE.Mesh(new THREE.CircleGeometry(2.4, 32), new THREE.MeshBasicMaterial({ color: 0x061226 }));
  reservoir.rotation.x = -Math.PI / 2;
  reservoir.scale.set(1.2, 1, 0.8);
  reservoir.position.set(0, 0.05, -38);
  scene.add(reservoir);
  const lampCount = 260;
  const lampPos = new Float32Array(lampCount * 3);
  for (let i = 0; i < lampCount; i++) {
    lampPos[i * 3] = (rand() - 0.5) * 7.8;
    lampPos[i * 3 + 1] = 0.12;
    lampPos[i * 3 + 2] = -5.5 - rand() * 54;
  }
  const lampGeo = new THREE.BufferGeometry();
  lampGeo.setAttribute("position", new THREE.BufferAttribute(lampPos, 3));
  scene.add(
    new THREE.Points(
      lampGeo,
      new THREE.PointsMaterial({ color: 0xffe2a8, size: 0.14, map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    ),
  );

  // Statue of Liberty on Liberty Island
  const liberty = new THREE.Group();
  const isle = new THREE.Mesh(new THREE.CircleGeometry(2.2, 24), new THREE.MeshBasicMaterial({ color: 0x0b1a12 }));
  isle.rotation.x = -Math.PI / 2;
  isle.position.y = 0.02;
  liberty.add(isle);
  const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.7).translate(0, 0.55, 0), new THREE.MeshBasicMaterial({ color: 0x3a3428 }));
  liberty.add(pedestal);
  const figure = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.26, 1.5, 10).translate(0, 1.85, 0), new THREE.MeshBasicMaterial({ color: 0x4fae8f }));
  liberty.add(figure);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.6, 6).translate(0, 0.3, 0), new THREE.MeshBasicMaterial({ color: 0x4fae8f }));
  arm.position.set(0.1, 2.4, 0);
  arm.rotation.z = -0.25;
  liberty.add(arm);
  liberty.position.set(-19, 0, 121);
  scene.add(liberty);
  sprite(0xffb547, 1.6, -18.75, 3.05, 121);

  scene.add(lights);
  return { beacons: [esbBeacon, wtcBeacon] };
}

function addBridge(scene, glow, { x0, x1, z, towerH, deckY, color }) {
  const group = new THREE.Group();
  const towerMat = new THREE.MeshBasicMaterial({ color: 0x2a2620 });
  const span = x1 - x0;
  const t0 = x0 + span * 0.22;
  const t1 = x1 - span * 0.22;
  [t0, t1].forEach((tx) => {
    const tower = new THREE.Mesh(new THREE.BoxGeometry(0.5, towerH, 0.9).translate(0, towerH / 2, 0), towerMat);
    tower.position.set(tx, 0, z);
    group.add(tower);
  });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(span, 0.12, 0.6), new THREE.MeshBasicMaterial({ color: 0x1a1814 }));
  deck.position.set((x0 + x1) / 2, deckY, z);
  group.add(deck);

  // "Necklace" lights along the main cables.
  const pts = [];
  const cable = (a, b, sag, from, to) => {
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const x = a + (b - a) * t;
      const y = from + (to - from) * t - sag * 4 * t * (1 - t);
      pts.push(x, y, z - 0.3, x, y, z + 0.3);
    }
  };
  cable(x0, t0, 0.15, deckY + 0.1, towerH);
  cable(t0, t1, towerH - deckY - 0.3, towerH, towerH);
  cable(t1, x1, 0.15, towerH, deckY + 0.1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
  group.add(
    new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color, size: 0.22, map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    ),
  );
  scene.add(group);
}

// ---------------------------------------------------------------------------
// Traffic and aviation lights
// ---------------------------------------------------------------------------

function createTraffic(rand, glow) {
  const lanes = [];
  // Avenues run north–south.
  for (let x = -16 * AVENUE; x <= 16 * AVENUE; x += AVENUE) {
    let zMin = null;
    let zMax = null;
    for (let z = -110; z < 100; z += 0.5) {
      if (insideManhattan(x, z, 0.6) && !(Math.abs(x) < 4.2 && z > -60 && z < -5)) {
        if (zMin === null) zMin = z;
        zMax = z;
      }
    }
    if (zMin !== null && zMax - zMin > 8) lanes.push({ axis: "z", fixed: x, min: zMin, max: zMax });
  }
  // A handful of crosstown streets (14th, 23rd, 34th, 42nd, 57th, 72nd, 86th...).
  [48, 39, 25, 15, -3, -20, -35, -50, -70, -88, 70, 82].forEach((z) => {
    const s = islandAt(z);
    if (s) lanes.push({ axis: "x", fixed: z, min: s.c - s.hw + 1, max: s.c + s.hw - 1 });
  });
  // Bridge decks.
  lanes.push({ axis: "x", fixed: 84, min: 8, max: 28, y: 1.05 });
  lanes.push({ axis: "x", fixed: -95, min: -30, max: -2, y: 1.85 });

  const perLane = 34;
  const count = lanes.length * perLane;
  const cars = [];
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const head = new THREE.Color(0xfff4dc);
  const tail = new THREE.Color(0xff3020);
  lanes.forEach((lane) => {
    for (let i = 0; i < perLane; i++) {
      const dir = rand() < 0.5 ? 1 : -1;
      const c = dir > 0 ? tail : head;
      const idx = cars.length;
      colors.set([c.r, c.g, c.b], idx * 3);
      cars.push({
        lane,
        dir,
        offset: dir * 0.07,
        t: lane.min + rand() * (lane.max - lane.min),
        speed: 1.2 + rand() * 2.8,
      });
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const points = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ size: 0.2, map: glow, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  points.frustumCulled = false;

  const update = (dt) => {
    cars.forEach((car, i) => {
      const { lane } = car;
      car.t += car.dir * car.speed * dt;
      if (car.t > lane.max) car.t = lane.min;
      if (car.t < lane.min) car.t = lane.max;
      const y = lane.y ?? 0.08;
      if (lane.axis === "z") positions.set([lane.fixed + car.offset, y, car.t], i * 3);
      else positions.set([car.t, y, lane.fixed + car.offset], i * 3);
    });
    geo.attributes.position.needsUpdate = true;
  };
  update(0);
  return { points, update };
}

function aviationLights(boxes) {
  const tops = boxes.filter((b) => b[4] + b[5] > 6.5);
  const pos = new Float32Array(tops.length * 3);
  const phase = new Float32Array(tops.length);
  tops.forEach((b, i) => {
    pos.set([b[0], b[4] + b[5] + 0.08, b[1]], i * 3);
    phase[i] = (i * 0.618) % 1;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
  const uniforms = { uTime: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aPhase;
      uniform float uTime;
      varying float vOn;
      void main() {
        vOn = smoothstep(0.75, 0.95, fract(uTime * 0.55 + aPhase));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(260.0 / -mv.z, 2.0, 12.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vOn;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * (0.15 + vOn);
        gl_FragColor = vec4(vec3(1.0, 0.18, 0.12) * a * 1.6, a);
      }
    `,
  });
  return { points: new THREE.Points(geo, mat), uniforms };
}

// ---------------------------------------------------------------------------
// Project towers (the AI district)
// ---------------------------------------------------------------------------

// Slots on the West Side, roughly Hudson Yards and Chelsea.
const DISTRICT = [-14.2, -7.2, 17.5, 42];
const SLOTS = [];
for (let row = 0; row < 8; row++) {
  for (const x of [-12.4, -9.4]) SLOTS.push([x + (row % 2) * 0.3, 19.5 + row * 3]);
}

function towerMaterial(color, uniforms) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...fogUniforms(),
      uTime: uniforms.uTime,
      uColor: { value: new THREE.Color(color) },
      uProgress: { value: 1 },
      uScan: { value: 0 },
      uSelected: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying float vDepth;
      varying float vLocalY;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vLocalY = position.y;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 mv = viewMatrix * wp;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uScan;
      uniform float uSelected;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying float vDepth;
      varying float vLocalY;
      ${FOG_GLSL}
      void main() {
        vec3 n = normalize(vNormalW);
        vec3 col = vec3(0.02, 0.026, 0.04);
        if (n.y < 0.5) {
          float floorLine = 1.0 - smoothstep(0.0, 0.06, abs(fract(vWorld.y / 0.38) - 0.5) * 2.0 - 0.9);
          float u = abs(n.x) > 0.5 ? vWorld.z : vWorld.x;
          float mullion = 1.0 - smoothstep(0.0, 0.08, abs(fract(u / 0.2) - 0.5) * 2.0 - 0.88);
          float glow = 0.25 + 0.2 * uSelected;
          col += uColor * (floorLine * glow + mullion * 0.08);
          col += uColor * 0.08 * (1.0 - vLocalY);
          // Training scan band sweeping up the facade.
          float band = exp(-pow((vLocalY - uScan) * 18.0, 2.0)) * step(0.001, uScan);
          col += uColor * band * 1.6;
        } else {
          col = uColor * 0.5;
        }
        gl_FragColor = vec4(applyFog(col, vDepth), 1.0);
      }
    `,
  });
}

function beamMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float a = pow(1.0 - vUv.y, 2.2) * 0.22;
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createCity(root, { onSelect } = {}) {
  const rand = mulberry32(1624);
  const glow = glowTexture();
  const lowPower = window.matchMedia("(max-width: 720px)").matches || (navigator.hardwareConcurrency || 8) <= 4;

  const renderer = new THREE.WebGLRenderer({ antialias: !lowPower, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, lowPower ? 1 : 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  root.appendChild(renderer.domElement);

  const labels = new CSS2DRenderer();
  labels.setSize(window.innerWidth, window.innerHeight);
  labels.domElement.className = "city-labels";
  root.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = FOG_COLOR;
  scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.3, 2000);
  camera.position.set(0, 70, 290);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 3, 30);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 8;
  controls.maxDistance = 320;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.18;

  scene.add(new THREE.HemisphereLight(0x6577aa, 0x1a120a, 0.6));
  const moonLight = new THREE.DirectionalLight(0xaab8ff, 0.7);
  moonLight.position.set(-80, 120, -60);
  scene.add(moonLight);

  const shared = { uTime: { value: 0 }, uLights: { value: 1 } };

  scene.add(skyDome());
  scene.add(stars(rand));
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xfff1d6, fog: false, transparent: true, depthWrite: false }));
  moon.scale.setScalar(40);
  moon.position.set(-260, 260, -620);
  scene.add(moon);

  const water = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), waterMaterial(shared));
  water.rotation.x = -Math.PI / 2;
  water.position.y = -0.04;
  scene.add(water);

  const land = landMaterial();
  scene.add(landMesh(manhattanOutline(), land));
  scene.add(landMesh([[-800, -800], [-26, -800], [-26, 800], [-800, 800]], land)); // New Jersey
  scene.add(landMesh([[24, -118], [800, -118], [800, 800], [24, 800]], land)); // Brooklyn & Queens
  scene.add(landMesh([[-26, -800], [800, -800], [800, -122], [-26, -122]], land)); // The Bronx

  const exclusions = [
    [-4.3, 4.3, -60.5, -4.5], // Central Park
    [0.2, 2.6, 24.2, 25.8], // Empire State
    [6.2, 7.8, 14.5, 16], // Chrysler
    [-7.8, -5.4, 86.8, 89.2], // One WTC
    [-4, 4, -3.6, -1.2], // Billionaires' Row
    DISTRICT,
  ];
  const boxes = generateBuildings(rand, exclusions);
  const { beacons } = addLandmarks(scene, boxes, rand, glow);
  scene.add(buildingMesh(boxes, shared));

  addBridge(scene, glow, { x0: 9, x1: 27, z: 84, towerH: 3.4, deckY: 1, color: 0xffe0a0 }); // Brooklyn Bridge
  addBridge(scene, glow, { x0: 12, x1: 26, z: 76, towerH: 3.0, deckY: 1, color: 0x9fc4ff }); // Manhattan Bridge
  addBridge(scene, glow, { x0: -30, x1: -2, z: -95, towerH: 6, deckY: 1.8, color: 0xfff1d0 }); // George Washington

  const traffic = createTraffic(rand, glow);
  scene.add(traffic.points);
  const aviation = aviationLights(boxes);
  scene.add(aviation.points);

  // District plaza under the project towers.
  const plaza = new THREE.Mesh(
    new THREE.PlaneGeometry(DISTRICT[1] - DISTRICT[0], DISTRICT[3] - DISTRICT[2]),
    new THREE.MeshBasicMaterial({ color: 0x0c0d12 }),
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.set((DISTRICT[0] + DISTRICT[1]) / 2, 0.02, (DISTRICT[2] + DISTRICT[3]) / 2);
  scene.add(plaza);

  // Post-processing bloom.
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.85, 0.55, 0.62);
  composer.addPass(bloom);

  // --- project towers -------------------------------------------------------
  const towers = new Map();
  const towerGroup = new THREE.Group();
  scene.add(towerGroup);
  const raycaster = new THREE.Raycaster();
  let selectedId = null;

  const targetHeight = (p) => {
    if (p.status === "trained") return 8 + ((p.modelCard?.qualityScore ?? 70) / 100) * 8;
    if (p.status === "training") return 5;
    return 3;
  };

  function makeTower(project, slot) {
    const color = STATUS_COLORS[project.status] ?? STATUS_COLORS.draft;
    const group = new THREE.Group();
    group.position.set(slot[0], 0, slot[1]);

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.25, 1, 1.25).translate(0, 0.5, 0), towerMaterial(color, shared));
    body.userData.projectId = project.id;
    group.add(body);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.27, 1, 1.27).translate(0, 0.5, 0)),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }),
    );
    group.add(edges);

    const crown = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glow, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    crown.scale.setScalar(2.4);
    group.add(crown);

    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 2.6, 46, 24, 1, true).translate(0, 23, 0), beamMaterial(color));
    beam.visible = false;
    group.add(beam);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.3, 1.55, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    group.add(ring);

    const el = document.createElement("button");
    el.className = "tower-label";
    el.type = "button";
    el.addEventListener("click", () => onSelect?.(project.id));
    const label = new CSS2DObject(el);
    group.add(label);

    towerGroup.add(group);
    return { group, body, edges, crown, beam, ring, label, el, height: 0.01, target: 3, progress: 0, status: project.status };
  }

  function setProjects(projects) {
    const seen = new Set();
    projects.slice(0, SLOTS.length).forEach((project, i) => {
      seen.add(project.id);
      let tower = towers.get(project.id);
      if (!tower) {
        tower = makeTower(project, SLOTS[i]);
        towers.set(project.id, tower);
      }
      tower.group.position.set(SLOTS[i][0], 0, SLOTS[i][1]);
      tower.status = project.status;
      tower.target = tower.status === "training" ? tower.target : targetHeight(project);
      const color = new THREE.Color(STATUS_COLORS[project.status] ?? STATUS_COLORS.draft);
      tower.body.material.uniforms.uColor.value.copy(color);
      tower.edges.material.color.copy(color);
      tower.crown.material.color.copy(color);
      tower.beam.material.uniforms.uColor.value.copy(color);
      tower.ring.material.color.copy(color);
      tower.beam.visible = project.status === "trained";
      tower.el.dataset.status = project.status;
      tower.el.dataset.bullet = project.bullet ?? "";
      tower.el.style.setProperty("--bullet", project.bulletColor ?? "#888");
      tower.el.innerHTML = "";
      const b = document.createElement("span");
      b.className = "tower-bullet";
      b.textContent = project.bullet ?? "";
      const n = document.createElement("span");
      n.className = "tower-name";
      n.textContent = project.name;
      tower.el.append(b, n);
    });
    for (const [id, tower] of towers) {
      if (!seen.has(id)) {
        towerGroup.remove(tower.group);
        tower.label.element.remove();
        towers.delete(id);
      }
    }
  }

  function setTraining(id, progress) {
    const tower = towers.get(id);
    if (!tower) return;
    tower.status = "training";
    tower.progress = progress;
    tower.target = 3 + progress * 9;
    const color = new THREE.Color(STATUS_COLORS.training);
    tower.body.material.uniforms.uColor.value.copy(color);
    tower.edges.material.color.copy(color);
    tower.crown.material.color.copy(color);
    tower.ring.material.color.copy(color);
    tower.beam.visible = false;
  }

  // --- camera choreography --------------------------------------------------
  let mode = "orbit";
  let tween = null;
  const tourCurve = new THREE.CatmullRomCurve3(
    [
      [34, 16, 150], [32, 10, 70], [26, 12, 0], [24, 16, -70], [-2, 24, -140],
      [-34, 14, -60], [-32, 9, 20], [-26, 8, 95], [4, 7, 140],
    ].map((p) => new THREE.Vector3(...p)),
    true,
    "centripetal",
  );
  let tourT = 0;

  function flyTo(position, target, duration = 2.2) {
    tween = {
      fromPos: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toPos: position,
      toTarget: target,
      t: 0,
      duration,
    };
  }

  function focusProject(id) {
    selectedId = id;
    const tower = towers.get(id);
    if (!tower) return;
    if (mode === "tour") setMode("orbit");
    const p = tower.group.position;
    flyTo(new THREE.Vector3(p.x + 15, Math.max(8, tower.target * 0.9), p.z + 17), new THREE.Vector3(p.x, tower.target * 0.55, p.z));
  }

  function setMode(next) {
    mode = next;
    controls.enabled = mode !== "tour";
    controls.autoRotate = mode === "orbit";
    if (mode === "orbit" && !tween) flyTo(new THREE.Vector3(34, 26, 140), new THREE.Vector3(0, 3, 30), 2.6);
    if (mode === "skyline") {
      mode = "orbit";
      controls.autoRotate = false;
      flyTo(new THREE.Vector3(6, 5, 168), new THREE.Vector3(-2, 6, 60), 3);
    }
  }

  const pointer = new THREE.Vector2();
  let downAt = 0;
  renderer.domElement.addEventListener("pointerdown", () => (downAt = performance.now()));
  renderer.domElement.addEventListener("pointerup", (event) => {
    if (performance.now() - downAt > 250) return;
    pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects([...towers.values()].map((t) => t.body))[0];
    if (hit) onSelect?.(hit.object.userData.projectId);
  });
  controls.addEventListener("start", () => (tween = null));

  // --- render loop ------------------------------------------------------------
  const clock = new THREE.Clock();
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const tmp = new THREE.Vector3();

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;
    shared.uTime.value = time;
    aviation.uniforms.uTime.value = time;
    traffic.update(dt);
    beacons.forEach((b, i) => (b.material.opacity = 0.35 + 0.65 * (Math.sin(time * 2.4 + i * 2) > 0.6 ? 1 : 0.2)));

    for (const [id, tower] of towers) {
      tower.height += (tower.target - tower.height) * Math.min(1, dt * 2.2);
      tower.body.scale.y = tower.height;
      tower.edges.scale.y = tower.height;
      tower.crown.position.y = tower.height + 0.4;
      tower.label.position.set(0, tower.height + 1.6, 0);
      const selected = id === selectedId ? 1 : 0;
      tower.body.material.uniforms.uSelected.value = selected;
      tower.body.material.uniforms.uScan.value = tower.status === "training" ? (time * 0.6) % 1 : 0;
      tower.ring.material.opacity = selected ? 0.55 + 0.35 * Math.sin(time * 3) : 0;
      tower.ring.scale.setScalar(1 + (selected ? 0.08 * Math.sin(time * 3) : 0));
      tower.crown.material.opacity = tower.status === "training" ? 0.5 + 0.5 * Math.sin(time * 6) : 0.9;
      if (tower.beam.visible) {
        tower.beam.rotation.z = Math.sin(time * 0.35 + tower.group.position.z) * 0.22;
        tower.beam.rotation.x = Math.cos(time * 0.27 + tower.group.position.x) * 0.18;
        tower.beam.position.y = tower.height;
      }
      tower.el.classList.toggle("is-selected", !!selected);
    }

    if (tween) {
      tween.t += dt / tween.duration;
      const k = ease(Math.min(1, tween.t));
      camera.position.lerpVectors(tween.fromPos, tween.toPos, k);
      controls.target.lerpVectors(tween.fromTarget, tween.toTarget, k);
      if (tween.t >= 1) tween = null;
    } else if (mode === "tour") {
      tourT = (tourT + dt / 110) % 1;
      tourCurve.getPointAt(tourT, camera.position);
      tourCurve.getPointAt((tourT + 0.04) % 1, tmp);
      const s = islandAt(THREE.MathUtils.clamp(tmp.z, -100, 95));
      controls.target.lerp(new THREE.Vector3(s ? s.c : 0, 3, THREE.MathUtils.clamp(tmp.z, -100, 95)), 0.05);
    }

    if (mode === "tour" && !tween) camera.lookAt(controls.target);
    else controls.update();

    composer.render();
    labels.render(scene, camera);
  }

  renderer.setAnimationLoop(frame);
  flyTo(new THREE.Vector3(34, 26, 140), new THREE.Vector3(0, 3, 30), 4.5);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    labels.setSize(window.innerWidth, window.innerHeight);
  });

  return { setProjects, setTraining, focusProject, setMode, stats: { buildings: boxes.length } };
}
