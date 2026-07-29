// ---------------------------------------------------------------------------
// Three.js scene: renderer, camera, controls, Earth, atmosphere, clouds, stars.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EARTH_RADIUS, TEXTURES } from './constants.js';

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.3,
    4000,
  );
  camera.position.set(0, EARTH_RADIUS * 1.4, EARTH_RADIUS * 3.2);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.55;
  controls.minDistance = EARTH_RADIUS * 1.08;
  controls.maxDistance = EARTH_RADIUS * 12;
  controls.zoomSpeed = 0.8;

  // --- Lighting ---
  const sunLight = new THREE.DirectionalLight(0xffffff, 1.4);
  scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0x223355, 0.35));

  // --- Earth (custom day/night shader) ---
  const earth = createEarth();
  scene.add(earth.group);

  // --- Atmosphere glow ---
  const atmosphere = createAtmosphere();
  scene.add(atmosphere);

  // --- Stars ---
  scene.add(createStarfield());

  function setSunDirection(dir) {
    sunLight.position.copy(dir).multiplyScalar(100);
    earth.material.uniforms.uSunDirection.value.copy(dir);
    atmosphere.material.uniforms.uSunDirection.value.copy(dir);
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener('resize', resize);

  return { renderer, scene, camera, controls, earth, sunLight, setSunDirection };
}

function createEarth() {
  const group = new THREE.Group();
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');

  const load = (url) =>
    loader.load(
      url,
      (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; },
      undefined,
      () => console.warn('Texture failed to load:', url),
    );

  const dayMap = load(TEXTURES.day);
  const specMap = load(TEXTURES.specular);
  const nightMap = load(TEXTURES.night);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uDay: { value: dayMap },
      uNight: { value: nightMap },
      uSpecular: { value: specMap },
      uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      void main() {
        vUv = uv;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uDay;
      uniform sampler2D uNight;
      uniform sampler2D uSpecular;
      uniform vec3 uSunDirection;
      varying vec2 vUv;
      varying vec3 vNormal;
      void main() {
        vec3 normal = normalize(vNormal);
        float sun = dot(normal, uSunDirection);
        float dayAmount = smoothstep(-0.12, 0.28, sun);

        vec3 dayColor = texture2D(uDay, vUv).rgb;
        // City lights glow on the dark side; oceans keep a faint cool sheen.
        vec3 lights = texture2D(uNight, vUv).rgb;
        float ocean = texture2D(uSpecular, vUv).r;
        vec3 nightColor = dayColor * 0.006 + vec3(0.003, 0.006, 0.014) * (0.3 + ocean * 0.5);
        nightColor += lights * vec3(1.0, 0.85, 0.55) * 1.6;

        vec3 color = mix(nightColor, dayColor, dayAmount);
        // Subtle warm scattering along the terminator.
        float terminator = smoothstep(0.0, 0.25, abs(sun));
        color += vec3(0.35, 0.18, 0.08) * (1.0 - terminator) * dayAmount * 0.35;

        gl_FragColor = vec4(color, 1.0);
        // The day/night textures are sampled in linear space (they are tagged
        // sRGB, so the GPU decodes on read). A raw ShaderMaterial does not get
        // the renderer's automatic output conversion, so re-encode to the
        // output colour space here — otherwise the lit day side renders far
        // too dark and reads as permanent night.
        #include <colorspace_fragment>
      }
    `,
  });

  const geometry = new THREE.SphereGeometry(EARTH_RADIUS, 96, 64);
  const mesh = new THREE.Mesh(geometry, material);
  group.add(mesh);

  // Cloud shell.
  const cloudTex = loader.load(
    TEXTURES.clouds,
    undefined,
    undefined,
    () => console.warn('Cloud texture failed to load'),
  );
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS * 1.006, 96, 64),
    new THREE.MeshPhongMaterial({
      map: cloudTex,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    }),
  );
  group.add(clouds);

  return { group, mesh, material, clouds };
}

function createAtmosphere() {
  const material = new THREE.ShaderMaterial({
    uniforms: { uSunDirection: { value: new THREE.Vector3(1, 0, 0) } },
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vWorldNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDirection;
      varying vec3 vNormal;
      varying vec3 vWorldNormal;
      void main() {
        float intensity = pow(0.72 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.0);
        float sun = smoothstep(-0.4, 0.5, dot(vWorldNormal, uSunDirection));
        vec3 glow = vec3(0.3, 0.6, 1.0) * intensity;
        gl_FragColor = vec4(glow, intensity) * (0.35 + 0.9 * sun);
      }
    `,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS * 1.16, 64, 48), material);
}

function createStarfield() {
  const count = 4000;
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Distribute on a large sphere shell.
    const r = 600 + Math.random() * 300;
    const theta = Math.acos(2 * Math.random() - 1);
    const phi = 2 * Math.PI * Math.random();
    positions[i * 3] = r * Math.sin(theta) * Math.cos(phi);
    positions[i * 3 + 1] = r * Math.cos(theta);
    positions[i * 3 + 2] = r * Math.sin(theta) * Math.sin(phi);
    sizes[i] = Math.random() < 0.06 ? 2.4 : 1.0;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.4,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.85,
  });
  return new THREE.Points(geo, mat);
}
