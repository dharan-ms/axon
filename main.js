(function () {
  "use strict";
  window.__errs = [];
  window.addEventListener("error", function (e) {
    window.__errs.push(String(e.message) + "\n" + (e.error && e.error.stack ? e.error.stack : ""));
  });
  var _consoleError = console.error.bind(console);
  console.error = function () {
    window.__errs.push(Array.prototype.map.call(arguments, String).join(" "));
    _consoleError.apply(console, arguments);
  };

  const SIM = 256;
  const DYE = 512;
  const FLUID_DT = 1 / 60;
  const CURL = 30;
  const VEL_DISS = 0.98;
  const DYE_DISS = 0.97;
  const PRESSURE_DISS = 0.95;
  const PRESSURE_ITERS = 5;
  // A unit-length SDF normal times 0.5 pins the shell in a few frames.
  // 0.05 lets the cloud form over the first few seconds and heal in 1–2s.
  const SURFACE_PULL = 0.05;
  const FLOW_SCALE = 0.0002;

  const BASE = new THREE.Vector3(-1.17, 0, 6);
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  const GRID = mobile ? 128 : 512;

  const canvas = document.getElementById("bg");
  const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: false,
    alpha: false,
    premultipliedAlpha: false,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 1);
  window.__renderer = renderer;
  renderer.autoClear = false;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.copy(BASE);
  const camTarget = BASE.clone();

  const scene = new THREE.Scene();
  const group = new THREE.Group();
  group.position.set(0.343, 0.16, -1);
  group.rotation.set(
    THREE.MathUtils.degToRad(-28.4),
    THREE.MathUtils.degToRad(390),
    THREE.MathUtils.degToRad(4.92)
  );
  group.scale.set(5, 5, 6);
  scene.add(group);

  const passScene = new THREE.Scene();
  const passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
  passCamera.position.z = 1;
  const passMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  passMesh.frustumCulled = false;
  passScene.add(passMesh);

  function makeTarget(w, h, type, filter) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: type,
      format: THREE.RGBAFormat,
      minFilter: filter,
      magFilter: filter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    });
    rt.texture.generateMipmaps = false;
    return rt;
  }

  function DoubleTarget(w, h, type, filter) {
    this.read = makeTarget(w, h, type, filter);
    this.write = makeTarget(w, h, type, filter);
  }
  DoubleTarget.prototype.swap = function () {
    const t = this.read;
    this.read = this.write;
    this.write = t;
  };

  const passVert = [
    "varying vec2 vUv;",
    "void main() {",
    "  vUv = position.xy * 0.5 + 0.5;",
    "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
    "}",
  ].join("\n");

  function passMaterial(fragment, uniforms) {
    return new THREE.ShaderMaterial({
      vertexShader: passVert,
      fragmentShader: "precision highp sampler2D;\n" + fragment,
      uniforms: uniforms,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      precision: "highp",
    });
  }

  function renderPass(material, target) {
    passMesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(passScene, passCamera);
  }

  function clearTarget(target) {
    renderer.setRenderTarget(target);
    renderer.clear(true, false, false);
  }

  const copyMat = passMaterial(
    [
      "varying vec2 vUv;",
      "uniform sampler2D uTexture;",
      "void main() {",
      "  gl_FragColor = texture2D(uTexture, vUv);",
      "}",
    ].join("\n"),
    { uTexture: { value: null } }
  );

  const multiplyMat = passMaterial(
    [
      "varying vec2 vUv;",
      "uniform sampler2D uTexture;",
      "uniform float uValue;",
      "void main() {",
      "  gl_FragColor = texture2D(uTexture, vUv) * uValue;",
      "}",
    ].join("\n"),
    { uTexture: { value: null }, uValue: { value: 1 } }
  );

  const splatMat = passMaterial(
    [
      "varying vec2 vUv;",
      "uniform sampler2D uTarget;",
      "uniform float uAspect;",
      "uniform vec3 uColor;",
      "uniform vec2 uPoint;",
      "uniform float uRadius;",
      "void main() {",
      "  vec2 p = vUv - uPoint;",
      "  p.x *= uAspect;",
      "  vec3 base = texture2D(uTarget, vUv).xyz;",
      "  float r = max(uRadius, 1e-6);",
      "  float splat = exp(-dot(p, p) / r);",
      "  gl_FragColor = vec4(base + splat * uColor, 1.0);",
      "}",
    ].join("\n"),
    {
      uTarget: { value: null },
      uAspect: { value: 1 },
      uColor: { value: new THREE.Vector3() },
      uPoint: { value: new THREE.Vector2() },
      uRadius: { value: 0.01 },
    }
  );

  const curlMat = passMaterial(
    [
      "varying vec2 vUv;",
      "uniform sampler2D uVelocity;",
      "uniform vec2 uTexel;",
      "void main() {",
      "  float L = texture2D(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;",
      "  float R = texture2D(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;",
      "  float T = texture2D(uVelocity, vUv + vec2(0.0, uTexel.y)).x;",
      "  float B = texture2D(uVelocity, vUv - vec2(0.0, uTexel.y)).x;",
      "  float vorticity = R - L - T + B;",
      "  gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);",
      "}",
    ].join("\n"),
    {
      uVelocity: { value: null },
      uTexel: { value: new THREE.Vector2(1 / SIM, 1 / SIM) },
    }
  );

  const vorticityMat = passMaterial(
    [
      "varying vec2 vUv;",
      "uniform sampler2D uVelocity;",
      "uniform sampler2D uCurl;",
      "uniform vec2 uTexel;",
      "uniform float uCurlStrength;",
      "uniform float uDt;",
      "void main() {",
      "  float L = texture2D(uCurl, vUv - vec2(uTexel.x, 0.0)).x;",
      "  float R = texture2D(uCurl, vUv + vec2(uTexel.x, 0.0)).x;",
      "  float T = texture2D(uCurl, vUv + vec2(0.0, uTexel.y)).x;",
      "  float B = texture2D(uCurl, vUv - vec2(0.0, uTexel.y)).x;",
      "  float C = texture2D(uCurl, vUv).x;",
      "  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));",
      "  force = force / (length(force) + 1e-4) * (uCurlStrength * C);",
      "  force.y *= -1.0;",
      "  vec2 velocity = texture2D(uVelocity, vUv).xy;",
      "  velocity += force * uDt;",
      "  velocity = clamp(velocity, vec2(-2000.0), vec2(2000.0));",
      "  gl_FragColor = vec4(velocity, 0.0, 1.0);",
      "}",
    ].join("\n"),
    {
      uVelocity: { value: null },
      uCurl: { value: null },
      uTexel: { value: new THREE.Vector2(1 / SIM, 1 / SIM) },
      uCurlStrength: { value: CURL },
      uDt: { value: FLUID_DT },
    }
  );

  const divergenceMat = passMaterial(
    [
      "varying vec2 vUv;",
      "uniform sampler2D uVelocity;",
      "uniform vec2 uTexel;",
      "void main() {",
      "  vec2 Luv = vUv - vec2(uTexel.x, 0.0);",
      "  vec2 Ruv = vUv + vec2(uTexel.x, 0.0);",
      "  vec2 Tuv = vUv + vec2(0.0, uTexel.y);",
      "  vec2 Buv = vUv - vec2(0.0, uTexel.y);",
      "  float L = texture2D(uVelocity, Luv).x;",
      "  float R = texture2D(uVelocity, Ruv).x;",
      "  float T = texture2D(uVelocity, Tuv).y;",
      "  float B = texture2D(uVelocity, Buv).y;",
      "  vec2 C = texture2D(uVelocity, vUv).xy;",
      "  if (Luv.x < 0.0) L = -C.x;",
      "  if (Ruv.x > 1.0) R = -C.x;",
      "  if (Tuv.y > 1.0) T = -C.y;",
      "  if (Buv.y < 0.0) B = -C.y;",
      "  float div = 0.5 * (R - L + T - B);",
      "  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);",
      "}",
    ].join("\n"),
    {
      uVelocity: { value: null },
      uTexel: { value: new THREE.Vector2(1 / SIM, 1 / SIM) },
    }
  );

  const pressureMat = passMaterial(
    [
      "varying vec2 vUv;",
      "uniform sampler2D uPressure;",
      "uniform sampler2D uDivergence;",
      "uniform vec2 uTexel;",
      "void main() {",
      "  float L = texture2D(uPressure, vUv - vec2(uTexel.x, 0.0)).x;",
      "  float R = texture2D(uPressure, vUv + vec2(uTexel.x, 0.0)).x;",
      "  float T = texture2D(uPressure, vUv + vec2(0.0, uTexel.y)).x;",
      "  float B = texture2D(uPressure, vUv - vec2(0.0, uTexel.y)).x;",
      "  float divergence = texture2D(uDivergence, vUv).x;",
      "  float pressure = (L + R + B + T - divergence) * 0.25;",
      "  gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);",
      "}",
    ].join("\n"),
    {
      uPressure: { value: null },
      uDivergence: { value: null },
      uTexel: { value: new THREE.Vector2(1 / SIM, 1 / SIM) },
    }
  );

  const gradientMat = passMaterial(
    [
      "varying vec2 vUv;",
      "uniform sampler2D uPressure;",
      "uniform sampler2D uVelocity;",
      "uniform vec2 uTexel;",
      "void main() {",
      "  float L = texture2D(uPressure, vUv - vec2(uTexel.x, 0.0)).x;",
      "  float R = texture2D(uPressure, vUv + vec2(uTexel.x, 0.0)).x;",
      "  float T = texture2D(uPressure, vUv + vec2(0.0, uTexel.y)).x;",
      "  float B = texture2D(uPressure, vUv - vec2(0.0, uTexel.y)).x;",
      "  vec2 velocity = texture2D(uVelocity, vUv).xy;",
      "  velocity.xy -= vec2(R - L, T - B);",
      "  velocity = clamp(velocity, vec2(-2000.0), vec2(2000.0));",
      "  gl_FragColor = vec4(velocity, 0.0, 1.0);",
      "}",
    ].join("\n"),
    {
      uPressure: { value: null },
      uVelocity: { value: null },
      uTexel: { value: new THREE.Vector2(1 / SIM, 1 / SIM) },
    }
  );

  const advectMat = passMaterial(
    [
      "varying vec2 vUv;",
      "uniform sampler2D uVelocity;",
      "uniform sampler2D uSource;",
      "uniform vec2 uTexel;",
      "uniform float uDt;",
      "uniform float uDissipation;",
      "void main() {",
      "  vec2 coord = vUv - uDt * texture2D(uVelocity, vUv).xy * uTexel;",
      "  coord = clamp(coord, uTexel * 0.5, 1.0 - uTexel * 0.5);",
      "  gl_FragColor = uDissipation * texture2D(uSource, coord);",
      "}",
    ].join("\n"),
    {
      uVelocity: { value: null },
      uSource: { value: null },
      uTexel: { value: new THREE.Vector2(1 / SIM, 1 / SIM) },
      uDt: { value: FLUID_DT },
      uDissipation: { value: 1 },
    }
  );

  const displayMat = passMaterial(
    [
      "varying vec2 vUv;",
      "uniform sampler2D uDensity;",
      "void main() {",
      "  vec3 d = texture2D(uDensity, vUv).rgb;",
      "  float a = max(d.r, max(d.g, d.b));",
      "  gl_FragColor = vec4(d, a);",
      "}",
    ].join("\n"),
    { uDensity: { value: null } }
  );

  const velocity = new DoubleTarget(SIM, SIM, THREE.HalfFloatType, THREE.LinearFilter);
  const density = new DoubleTarget(DYE, DYE, THREE.HalfFloatType, THREE.LinearFilter);
  const pressure = new DoubleTarget(SIM, SIM, THREE.HalfFloatType, THREE.NearestFilter);
  const curlTarget = makeTarget(SIM, SIM, THREE.HalfFloatType, THREE.NearestFilter);
  const divergenceTarget = makeTarget(SIM, SIM, THREE.HalfFloatType, THREE.NearestFilter);
  const displayTarget = makeTarget(
    Math.max(1, window.innerWidth),
    Math.max(1, window.innerHeight),
    THREE.HalfFloatType,
    THREE.LinearFilter
  );

  [velocity.read, velocity.write, density.read, density.write, pressure.read, pressure.write, curlTarget, divergenceTarget, displayTarget].forEach(clearTarget);

  function splatAt(target, x, y, color, radiusPx) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const radiusUv = Math.max(radiusPx, 0.5) / 200;
    splatMat.uniforms.uTarget.value = target.read.texture;
    splatMat.uniforms.uAspect.value = w / Math.max(h, 1);
    splatMat.uniforms.uColor.value.set(color[0], color[1], color[2]);
    splatMat.uniforms.uPoint.value.set(x / w, 1 - y / h);
    splatMat.uniforms.uRadius.value = radiusUv * radiusUv;
    renderPass(splatMat, target.write);
    target.swap();
  }

  function splatLine(x0, y0, x1, y1, vx, vy, radiusPx) {
    const h = window.innerHeight;
    const visual = (Math.max(radiusPx, 0.5) / 200) * h;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const step = Math.max(visual * 0.45, 1);
    const steps = Math.max(1, Math.ceil(dist / step));
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      splatAt(velocity, x, y, [vx, vy, 1], radiusPx);
      splatAt(density, x, y, [1, 1, 1], radiusPx);
    }
  }

  function stepFluid() {
    curlMat.uniforms.uVelocity.value = velocity.read.texture;
    renderPass(curlMat, curlTarget);

    vorticityMat.uniforms.uVelocity.value = velocity.read.texture;
    vorticityMat.uniforms.uCurl.value = curlTarget.texture;
    renderPass(vorticityMat, velocity.write);
    velocity.swap();

    divergenceMat.uniforms.uVelocity.value = velocity.read.texture;
    renderPass(divergenceMat, divergenceTarget);

    multiplyMat.uniforms.uTexture.value = pressure.read.texture;
    multiplyMat.uniforms.uValue.value = PRESSURE_DISS;
    renderPass(multiplyMat, pressure.write);
    pressure.swap();

    for (let i = 0; i < PRESSURE_ITERS; i++) {
      pressureMat.uniforms.uPressure.value = pressure.read.texture;
      pressureMat.uniforms.uDivergence.value = divergenceTarget.texture;
      renderPass(pressureMat, pressure.write);
      pressure.swap();
    }

    gradientMat.uniforms.uPressure.value = pressure.read.texture;
    gradientMat.uniforms.uVelocity.value = velocity.read.texture;
    renderPass(gradientMat, velocity.write);
    velocity.swap();

    advectMat.uniforms.uDissipation.value = VEL_DISS;
    advectMat.uniforms.uVelocity.value = velocity.read.texture;
    advectMat.uniforms.uSource.value = velocity.read.texture;
    renderPass(advectMat, velocity.write);
    velocity.swap();

    advectMat.uniforms.uDissipation.value = DYE_DISS;
    advectMat.uniforms.uVelocity.value = velocity.read.texture;
    advectMat.uniforms.uSource.value = density.read.texture;
    renderPass(advectMat, density.write);
    density.swap();

    displayMat.uniforms.uDensity.value = density.read.texture;
    renderPass(displayMat, displayTarget);
  }

  const count = GRID * GRID;
  const originData = new Float32Array(count * 4);
  const randomData = new Float32Array(count * 4);
  const uvPos = new Float32Array(count * 3);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const i = y * GRID + x;
      originData[i * 4] = Math.random() * 2 - 1;
      originData[i * 4 + 1] = Math.random() * 2 - 1;
      originData[i * 4 + 2] = Math.random() * 2 - 1;
      originData[i * 4 + 3] = 1;
      randomData[i * 4] = Math.random();
      randomData[i * 4 + 1] = Math.random();
      randomData[i * 4 + 2] = Math.random();
      randomData[i * 4 + 3] = Math.random();
      uvPos[i * 3] = (x + 0.5) / GRID;
      uvPos[i * 3 + 1] = (y + 0.5) / GRID;
      uvPos[i * 3 + 2] = 0;
    }
  }

  function dataTex(data) {
    const tex = new THREE.DataTexture(data, GRID, GRID, THREE.RGBAFormat, THREE.FloatType);
    tex.flipY = false;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  const originTex = dataTex(originData);
  const positions = new DoubleTarget(GRID, GRID, THREE.FloatType, THREE.NearestFilter);
  copyMat.uniforms.uTexture.value = originTex;
  renderPass(copyMat, positions.read);
  renderPass(copyMat, positions.write);

  const simFrag = [
    "varying vec2 vUv;",
    "uniform sampler2D uPosition;",
    "uniform sampler2D uOrigin;",
    "uniform sampler2D uVelocity;",
    "uniform sampler2D uDensity;",
    "uniform float uTime;",
    "uniform float uHZ;",
    "uniform float uPull;",
    "uniform float uFlow;",
    "uniform float uMouse;",
    "uniform mat4 uProjection;",
    "uniform mat4 uModel;",
    "uniform mat3 uFlowRot;",
    "",
    "vec3 quatRotate(vec3 v, vec4 q) {",
    "  vec3 t = 2.0 * cross(q.xyz, v);",
    "  return v + q.w * t + cross(q.xyz, t);",
    "}",
    "",
    "float sdTorus(vec3 p, vec2 t) {",
    "  vec2 q = vec2(length(p.xz) - t.x, p.y);",
    "  return length(q) - t.y;",
    "}",
    "",
    "float smin(float a, float b, float k) {",
    "  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);",
    "  return mix(b, a, h) - k * h * (1.0 - h);",
    "}",
    "",
    "float smax(float a, float b, float k) {",
    "  return -smin(-a, -b, k);",
    "}",
    "",
    "float sdfShape(vec3 p) {",
    "  if (length(p) > 0.8) return length(p) - 0.7;",
    "  p.z = sqrt(p.z * p.z + 0.0215) - sqrt(0.012);",
    "  p = quatRotate(p, vec4(0.5, 0.5, 0.5, 0.5));",
    "  float ang = atan(p.z, p.x);",
    "  vec3 q = p;",
    "  q.x += 0.045 * sin(ang * 2.0);",
    "  q.y += 0.05 * sin(ang * 3.0 + 0.6);",
    "  float twist = ang * 0.65;",
    "  float cs = cos(twist);",
    "  float sn = sin(twist);",
    "  q.yz = mat2(cs, -sn, sn, cs) * q.yz;",
    "  float ring = sdTorus(q, vec2(0.28, 0.1));",
    "  float gap = length(q - vec3(0.34, 0.02, 0.0)) - 0.22;",
    "  float body = smax(ring, -gap, 0.055);",
    "  float lobeA = length(q - vec3(-0.18, 0.15, 0.04)) - 0.125;",
    "  float lobeB = length(q - vec3(-0.05, -0.16, 0.02)) - 0.11;",
    "  body = smin(body, lobeA, 0.085);",
    "  body = smin(body, lobeB, 0.075);",
    "  body += 0.012 * sin(q.x * 14.0) * sin(q.y * 11.0) * sin(q.z * 9.0);",
    "  return body;",
    "}",
    "",
    "vec3 sdfNormal(vec3 p) {",
    "  float e = 0.001;",
    "  vec3 g = vec3(",
    "    sdfShape(p + vec3(e, 0.0, 0.0)) - sdfShape(p - vec3(e, 0.0, 0.0)),",
    "    sdfShape(p + vec3(0.0, e, 0.0)) - sdfShape(p - vec3(0.0, e, 0.0)),",
    "    sdfShape(p + vec3(0.0, 0.0, e)) - sdfShape(p - vec3(0.0, 0.0, e))",
    "  );",
    "  float mag = length(g);",
    "  return mag > 1e-6 ? g / mag : vec3(0.0, 1.0, 0.0);",
    "}",
    "",
    "vec3 curlNoise(vec3 p) {",
    "  float dsxdy = 1.31 * cos(p.y * 1.31 + 0.7) + 1.085 * cos(p.y * 2.17 + p.z * 0.91);",
    "  float dsxdz = 1.73 * cos(p.z * 1.73 + 1.1) + 0.455 * cos(p.y * 2.17 + p.z * 0.91);",
    "  float dsydz = 1.17 * cos(p.z * 1.17 + 0.3) + 0.365 * cos(p.z * 0.73 + p.x * 1.21);",
    "  float dsydx = 1.53 * cos(p.x * 1.53 + 2.4) + 0.605 * cos(p.z * 0.73 + p.x * 1.21);",
    "  float dszdx = 1.41 * cos(p.x * 1.41 + 1.8) + 0.305 * cos(p.x * 0.61 + p.y * 1.63);",
    "  float dszdy = 0.97 * cos(p.y * 0.97 + 0.2) + 0.815 * cos(p.x * 0.61 + p.y * 1.63);",
    "  vec3 c = vec3(dszdy - dsydz, dsxdz - dszdx, dsydx - dsxdy);",
    "  float mag = length(c);",
    "  return mag > 1e-5 ? c / mag : vec3(0.0);",
    "}",
    "",
    "void main() {",
    "  vec3 pos = texture2D(uPosition, vUv).xyz;",
    "  vec3 origin = texture2D(uOrigin, vUv).xyz;",
    "  if (length(pos) > 0.7) pos /= 2.0;",
    "  pos += curlNoise(pos * 0.1 + uTime * 0.05) * 0.0002 * uHZ;",
    "  vec3 gradient = sdfNormal(pos);",
    "  float sdf = sdfShape(pos);",
    "  vec3 radial = length(pos) > 1e-5 ? normalize(pos) : vec3(0.0, 1.0, 0.0);",
    "  pos += cross(radial, gradient) * 0.0005;",
    "  pos += -gradient * sdf * uPull;",
    "  pos += (origin - pos) * 0.0002 * uHZ;",
    "  vec4 clip = uProjection * (uModel * vec4(pos, 1.0));",
    "  vec2 screenUV = (clip.xy / max(clip.w, 1e-4)) * 0.5 + 0.5;",
    "  vec2 vel = texture2D(uVelocity, screenUV).xy;",
    "  vec3 flow = uFlowRot * vec3(vel, 0.0);",
    "  float dye = texture2D(uDensity, screenUV).r;",
    "  pos += flow * uFlow * uHZ * uMouse * dye;",
    "  gl_FragColor = vec4(pos, 1.0);",
    "}",
  ].join("\n");

  const simMat = passMaterial(simFrag, {
    uPosition: { value: null },
    uOrigin: { value: originTex },
    uVelocity: { value: null },
    uDensity: { value: null },
    uTime: { value: 0 },
    uHZ: { value: 1 },
    uPull: { value: SURFACE_PULL },
    uFlow: { value: FLOW_SCALE },
    uMouse: { value: 0.4 },
    uProjection: { value: new THREE.Matrix4() },
    uModel: { value: new THREE.Matrix4() },
    uFlowRot: { value: new THREE.Matrix3() },
  });

  const pointVert = [
    "precision highp sampler2D;",
    "attribute vec4 random;",
    "uniform sampler2D uPosition;",
    "uniform float uDPR;",
    "varying vec4 vRandom;",
    "varying float vScale;",
    "void main() {",
    "  vec3 pos = texture2D(uPosition, position.xy).xyz;",
    "  pos *= mix(1.0, 1.5, pow(random.y, 150.0));",
    "  vec4 mv = modelViewMatrix * vec4(pos, 1.0);",
    "  float viewDistance = max(length(mv.xyz), 0.001);",
    "  float scale = smoothstep(3.0, 15.0, viewDistance) * mix(0.5, 1.0, random.z);",
    "  gl_PointSize = 0.04 * uDPR * 2.0 * scale * (1000.0 / viewDistance);",
    "  gl_Position = projectionMatrix * mv;",
    "  vRandom = random;",
    "  vScale = scale;",
    "}",
  ].join("\n");

  const pointFrag = [
    "precision highp sampler2D;",
    "varying vec4 vRandom;",
    "varying float vScale;",
    "uniform sampler2D uMatcap;",
    "uniform float uTime;",
    "float softLight(float b, float s) {",
    "  return (s < 0.5)",
    "    ? b - (1.0 - 2.0 * s) * b * (1.0 - b)",
    "    : b + (2.0 * s - 1.0) * (sqrt(max(b, 0.0)) - b);",
    "}",
    "float overlay(float b, float s) {",
    "  return (b < 0.5) ? (2.0 * b * s) : (1.0 - 2.0 * (1.0 - b) * (1.0 - s));",
    "}",
    "void main() {",
    "  if (vScale < 0.1) discard;",
    "  vec2 uv = gl_PointCoord;",
    "  vec2 c = uv * 2.0 - 1.0;",
    "  if (dot(c, c) > 1.0) discard;",
    "  vec3 base = vec3(mix(0.0, 0.2, vRandom.x));",
    "  base = mix(base, vec3(0.6, 0.45, 1.0), pow(vRandom.z, 100.0));",
    "  float sparkle = 0.5 + (0.4 + sin(uTime * 4.0 + vRandom.y * 20.0)) * pow(vRandom.z, 10.0) * 2.5;",
    "  base *= sparkle;",
    "  float ang = sin(uTime + vRandom.z * 20.0) * 0.5 + 1.0;",
    "  float ca = cos(ang);",
    "  float sa = sin(ang);",
    "  vec2 centered = uv - 0.5;",
    "  vec2 rot = vec2(ca * centered.x - sa * centered.y, sa * centered.x + ca * centered.y) + 0.5;",
    "  vec3 matcap = texture2D(uMatcap, rot).rgb;",
    "  vec3 soft = vec3(softLight(base.r, matcap.r), softLight(base.g, matcap.g), softLight(base.b, matcap.b));",
    "  vec3 col = mix(base, soft, 0.8);",
    "  vec3 over = vec3(overlay(col.r, matcap.r), overlay(col.g, matcap.g), overlay(col.b, matcap.b));",
    "  col = mix(col, over, 0.2);",
    "  gl_FragColor = vec4(col, 1.0);",
    "}",
  ].join("\n");

  const matcapTex = new THREE.Texture();
  matcapTex.minFilter = THREE.LinearFilter;
  matcapTex.magFilter = THREE.LinearFilter;
  matcapTex.generateMipmaps = false;
  matcapTex.wrapS = THREE.ClampToEdgeWrapping;
  matcapTex.wrapT = THREE.ClampToEdgeWrapping;

  const pointsMat = new THREE.ShaderMaterial({
    vertexShader: pointVert,
    fragmentShader: pointFrag,
    uniforms: {
      uPosition: { value: positions.read.texture },
      uDPR: { value: Math.min(window.devicePixelRatio || 1, 2) },
      uMatcap: { value: matcapTex },
      uTime: { value: 0 },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    precision: "highp",
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(uvPos, 3));
  geo.setAttribute("random", new THREE.BufferAttribute(randomData, 4));
  const points = new THREE.Points(geo, pointsMat);
  points.frustumCulled = false;
  group.add(points);

  const projScreen = new THREE.Matrix4();
  const camRot = new THREE.Matrix4();
  const invGroup = new THREE.Matrix4();
  const flowMat = new THREE.Matrix4();
  const flow3 = new THREE.Matrix3();

  const pointer = {
    x: window.innerWidth * 0.5,
    y: window.innerHeight * 0.5,
    prevX: window.innerWidth * 0.5,
    prevY: window.innerHeight * 0.5,
    lastSplat: 0,
    moved: false,
  };

  function clampMap(v, in0, in1, out0, out1) {
    const t = Math.min(1, Math.max(0, (v - in0) / (in1 - in0)));
    return out0 + (out1 - out0) * t;
  }

  function onPoint(x, y) {
    pointer.x = x;
    pointer.y = y;
    pointer.moved = true;
  }

  window.addEventListener("mousemove", function (e) {
    onPoint(e.clientX, e.clientY);
  });
  window.addEventListener("touchstart", function (e) {
    const t = e.touches[0];
    if (t) onPoint(t.clientX, t.clientY);
  }, { passive: true });
  window.addEventListener("touchmove", function (e) {
    const t = e.touches[0];
    if (t) onPoint(t.clientX, t.clientY);
  }, { passive: true });

  function applyPointer() {
    const now = performance.now();
    const dx = pointer.x - pointer.prevX;
    const dy = pointer.y - pointer.prevY;
    const len = Math.hypot(dx, dy);
    if (pointer.moved && len > 0.01) {
      let x0 = pointer.prevX;
      let y0 = pointer.prevY;
      if (now - pointer.lastSplat > 50) {
        x0 = pointer.x;
        y0 = pointer.y;
      }
      let radius = clampMap(len, 0, 5, 0, 60) * 0.6;
      if (window.matchMedia("(max-width: 760px)").matches) radius *= 0.8;
      const mult = clampMap(len, 0, 15, 0, 10);
      splatLine(x0, y0, pointer.x, pointer.y, dx * mult, -dy * mult, radius);
      pointer.lastSplat = now;
    }
    pointer.prevX = pointer.x;
    pointer.prevY = pointer.y;
  }

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    pointsMat.uniforms.uDPR.value = dpr;
    displayTarget.setSize(Math.max(1, w), Math.max(1, h));
    if (!pointer.moved) {
      pointer.x = pointer.prevX = w * 0.5;
      pointer.y = pointer.prevY = h * 0.5;
    }
  }
  window.addEventListener("resize", resize);

  document.querySelectorAll("video").forEach(function (video) {
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    const attempt = video.play();
    if (attempt && typeof attempt.catch === "function") attempt.catch(function () {});
  });

  const matcapTexUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAN70lEQVR4nNWbZ7MVVROF+eyfIqNkUCQHFRXBQFByDoIISFQRQTEioOSsiJIVAYkGRDAgqIgBFYltPbtqTfXd7Jkz94i8vlR1wT0zZ0+v1atX75m51LnlllvsZsRzzz1nzz//vC1YsMBeeOEFW7hwob300kv28ssv2yuvvGKvvvqqvfbaa/b666/bokWLbkpORJ1/a+FZs2bZ008/bc8++2wu+BTwN954I8TixYtDLFmyJMT/DQHTp08P4OfMmWPPPPOMzZ071+bNm2fz58/PwKvqMXABXrp0aRZvvvlmFvz8nyTgiSeesClTpthTTz1lM2fOtNmzZ4fqVwIv4AINyLfeesuWLVuWDI4pOPc/QcCkSZPsySeftGnTptWofiz9F198MZO9wFNxgAv0ihUrbOXKlbZq1aoQq1evzv7N5xwnli9fnhHyPyNg3Lhx9vjjjyer76WfAq+qU0WAAA6wa9eutXXr1tmGDRtCbNy4Mfv3+vXrw3GRcqOIqIqAMWPG2Pjx423ixIk2efJkmzp1am71vfRVecCTNCAAJNBvv/22bd682bZs2WLvvfeevf/+++Fvfn733XftnXfeCaRAxpo1a2oQUS0JtSJg2LBhNnLkSBs7dqxNmDChhvxnzJhxXe/76uP2MXhAAAbggNy6davt2LHDdu/ebR9++GEWH3zwge3atSscgxTI2LRpU0YEChIJtfWG0gQMHjzYhg8fbqNGjaoo/7j6SB+3p+dJUOCpOhUH1M6dOwPYffv22cGDB+3w4cN29OjREEeOHLFDhw7Zxx9/bHv27AlkQBbfZQ1aAzVUQ0IpAh577DEbMmRIIGD06NGBgFj+EODlj/PH1cfwSBLZCzxAqPjevXsDyE8//dS++OILO3nypH399df2zTffhL/5mc8/+eQTO3DgQCACRaAc1BCTUHZkViSgf//+NnDgQBs6dKiNGDGisP+18fHyV+9TfRJDrvQ8sqfyVJOqU+Vjx44FsKdPn7Yff/zRzp07Z7/88ov9/PPP9tNPP9n3339v3377rR0/fjwog+/xfXxCJLA+xlh231BIwMMPP1yDAPpfBMT9LwLof40+L396n8RUffqYCn700UdB7oCn2j/88IP9+uuv9ueff9qlS5fsypUrIfg3n3EMIr766quglv379wcSUAIGSWvRYlwLAirtIgsJeOSRR2zAgAE2aNCgjIAiA9T4U//H8icxqqTqI336+rPPPguAAP/bb7/ZxYsXLe/P1atX7Y8//rCzZ88GtYgEPARSMUZIphVQQdUE9OnTpwYBZSZAbIAigLlPMpI/42zbtm2hj+l7evu7774LUv/rr79ywfs/qAESII52QEmsCblqBXkB7VcrAu6///5SBDABKhGgjQ/JYFJUCPND/hgfvX/ixAk7c+ZMqD5yL/vn999/D+2AJzA5UBStQIt5FUBA3h1mLgEPPvig9e3btwYBjMBqCJABigD1PwRQPRwe+QPo2rVrpQnAF1AN3sF0iFVAy6kNKEIpAu65555MATEB1bRASgExASiAStaWAM49f/58mBqYKH6CF6AwWk1tIAIw40ICAO8JqMYDUiboPUAtsH379mwCfPnll6EFcPjLly+XJoA/GGJeG0A408ATwFTKJaBbt265BPgxmCIgbwzmTQE2QOz8SJrqMd+Z+xcuXKg1AbQPJGKobJvZFzAS8QFPAGqsSMDdd999HQHVboTifQCmxJwmOZJkfjPC6F98gEpihGVVwEikBVBPJQIoQiEBHTt2tK5duwYC7rvvPuvdu3eNjRBbYQhgK5wiIG8rHO8E/SSgDTQKtRFitOEFZUhgZGKCp06dCt9XCxQRQD4U5joCOnToEAi466677N57780I6NevX/JeoOzNkPcB3wZsXaUCbYXpY8BAApVlQ5QyRT4DPGpB/n5XiAl6D5AJQgB5JAkAdPv27a1Lly7Wo0ePQMADDzxgDz30UCDg0UcfDXeDqVGY5wN5bUBFpAI2RHgBsiV5JgIk4AcAo7qoAV+ADALg9D33CJyDathIYaaYKqqKpwDqkwFSEJRJbhkByB8COnfuHAjo2bOn9erVK9sLQICfBHk+kGqDlArkBbonYHaLBN0UUVV2h4DkRgiDhBD+5kaJ0cdWGPAQx3eRP1ts3RihNq7nDZCCkBO5ZQS0a9fO7rzzTuvUqZN17949OQm8Eea1QWocxirwzwRIkl71JNAOqdtiVKHgZ0zv888/D4QBnu+yBtVHXX4ExvInJ3LLCLj99tsDCShBk8AbYewDeW2QeiwWq8A/FUKingTaAU/AGAEFEVQXMgCr4GeAY3oQBnikzxr+jhCi/fwnB1WfFg0EUO02bdrYHXfcEYwQH5ARygfKtEHRY3H/bCCPBNoBT8AYAQMR7BPYLUIGuzwehPA3P/M5xzmPyusxmb8Riquv3qf6FIci1cH5W7dubW3bts18oKgN/DhUG+SpwE8EtULRw1GkCwhkDBEAY8sMSPpboeeDHOc8zqfyeiqkZwHqfUnfV5/iUKQ69H2rVq2CCmgDfi5qA02DIhX4iVDmCTFSxRhJHhAiAkVQWT0lVvinxPHDUQ8+5fzkAXiKQ5HqIPuWLVsGEuI2iKdBnhl6L/ATQa0Q+4FIQJoyRr0gQQ0QASBGGeD0jgCw/K33BRz3j8d1/18EXtInL4pUB9lDAJHXBmVUoIngWyH1ogQSyrwpQhEig/YgAKt/622RXo7ottdveYvAkxf5BQJatGhhzZs3D16gaeB3hZhhrILURPCt4DdH/kVp6nWZV4OIUGvkvSvU428991PVWScPvJc+4ClSRkDTpk1DGzASK6nA7wxTrZDyAy4ae4Jvifh1efyqXK/JCb065xjnAVxV94aXB558yIsiZS1w6623BiJkhrEK5AVMBH+D5Fshngr4gSfBe4JaoswvTeg1ug8+47ivON9X1eX2kn0MnrwoUmaCt912mzVr1ixXBZoI8b7At4L3g5iE2Bh9S3hvgAhAiAwRkgqBjoFDqkad73kPnrxQajYGIaBIBZoI7At8K+hhCa0gP/AkeE8QCXFLeCLUGiJDhKRCMo+Bx1WX4XF9D578so0QHtC4ceOkCrQv8IaoVtBUKEuCWkJqSBHhyRAhqdBxgVbFAc6akrzAc33yEHjyy7bCAIcAVKCJ4PcF3CWmWoGp4EdjEQlxS3hvEBEkDwgR4kmJQ8cFOgVckk+Bx7OymyFAN2nSJJCAGrQv4C4xbgVNBU8CphiTIGPUiNQ+watBRKg1PBkipCh0nqTugavqkM51uT55kA951bgdpvepfqNGjQIRcStoi+yngvwgJsG3gychVkMeEZ4MBQB96HPOi0Gr4gD3VffgGd01HojICFFAw4YNw78hxbeCpoL8IEWC9wSmAyOSi6klpIaYCJL1ZIgQT4oPHfOgU8BVdcjn+uRBPuRV45GYfIDqQ4BvBU0F+UEZEjQiUy0hbxARJBmTIUJESip0XOfzXdZIAee6XJ88yIe8ajwUpcq+DRo0aJC1QuwHeSTIE5gOfp/AxbwaPBFqjRQZCoClQsc5X6AldQ/cV508UGfysThtoHEIASgBQuQHlUiQMTIitU+QL3g1eCJILo8MBcBSoeOcL9Cs4Ssu4Ko6eVCY5IsRADINAA34+vXrZyTwuUwxjwRNB/YJviU8EbDviUCSKTJEiEhJhY7rfFU7BZzrcn3yyH0zpPsCmSEqqFevXmgJPisiQSOSfQKbJbWE1OC9wROBJFNkiBCREoeOecB8Xz3OujFwCkF7Fr4c9SoAOCogikjQbhEStFlSS3g1cHER4VsjJsMTUik4T5X2oFlXwLke16UQFKTw9ThO771ArZAiAbI0HSCBzRI7RlpCGyapwRMhRVARr4qYEJGSFzpHgAWa9ViX9T1wFFnqFySobjwRaAWR4D0BEpgg2iz5lkAN8oaYCLWGVCEyqBjhSfHkxJ9xHqFKCzTrQraAc93SvyFCNbUviEmQJ2g6aJ8QtwRqkEHGRKg1SExkSBkiRKSImDh0zAPm+wLNuqwP6VyPlixNgAxRraDNEQoQCfzM5xzXjlEt4dWAN6gtPBEk5FUhMjwhIiUvdI4HzFoCzfpcC0/Kw1n4a3JImwrHfgABdevWDargc/lCrAa8ISZCrYFHxGSQNMmLFBGTFzpHgGPQrM+1ijAWEkCy8gN/n+BJ8L4gNXhviIlQa3hViAySJnmRImLyQud4wKzFmqxN/kTVBBAkDJiYBHkCJKglpAZ5g9pCRNAa8oiYDBIVISJFxOSFzvGAWYs1URzrV8JX6pelPQnyBBljSg0c920BEWoNvYlGFZDhlUHShEhRqJI+dIxzPWDWkgmXwVb61+VZEADyBE2HuCXkDZ4IFKHWgAipQmSgDE8IAKQSHwKo0Hl8h++yBmuVBV8rAuQJJA4QjUhkn1IDf8dEQJxUwRpqEYj1hIgUEZMKHdf5fJc1KvX8PyLAj0gqqZYQEfIG7Rx9a8gjOFeqgAzW8IRIISKmKHQe3yGnarBU/Z+mkB5JkDhA9FhdikiRIVWIDJSh6QEhMSkKruHDf04O5FItjn/83+aQI1UgIZKXIvSAVWSIEE+KlME5IkSkQKiCNRVqIa7Jtf9p/jfkP04yhpAgSVEVKkg1pQqRIUKKQud5IryJ6g12pQ3OTSXAB26MGdGXIoOqAYIKqqqA8+Gr7VtBk4M1WftG5/uv/edp3JiEcWf6FBCYnO9hAPp+90bof3Grts7+nyAg1SbMZ2a2H2N+3HGMc26UvMvE34Tf6Q7mROS4AAAAAElFTkSuQmCC";
  const matcapImg = new Image();
  matcapImg.onload = function () {
    matcapTex.image = matcapImg;
    matcapTex.needsUpdate = true;
    start();
  };
  matcapImg.onerror = function () {
    start();
  };
  matcapImg.src = matcapTexUri;

  let started = false;
  let last = performance.now();
  let elapsed = 0;

  function start() {
    if (started) return;
    started = true;
    last = performance.now();
    requestAnimationFrame(frame);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) dt = FLUID_DT;
    if (dt > 0.05) dt = 0.05;
    elapsed += dt;

    const nx = (pointer.x / Math.max(window.innerWidth, 1)) * 2 - 1;
    const ny = (pointer.y / Math.max(window.innerHeight, 1)) * 2 - 1;
    camTarget.set(BASE.x + nx * -1, BASE.y + ny * 2, BASE.z);
    camera.position.lerp(camTarget, 0.05);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    group.updateMatrixWorld(true);

    applyPointer();
    stepFluid();

    camRot.makeRotationFromQuaternion(camera.quaternion);
    invGroup.makeRotationFromQuaternion(group.quaternion).invert();
    flowMat.multiplyMatrices(invGroup, camRot);
    flow3.setFromMatrix4(flowMat);
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    simMat.uniforms.uPosition.value = positions.read.texture;
    simMat.uniforms.uVelocity.value = velocity.read.texture;
    simMat.uniforms.uDensity.value = displayTarget.texture;
    simMat.uniforms.uTime.value = elapsed;
    simMat.uniforms.uHZ.value = dt * 60;
    simMat.uniforms.uProjection.value.copy(projScreen);
    simMat.uniforms.uModel.value.copy(group.matrixWorld);
    simMat.uniforms.uFlowRot.value.copy(flow3);
    renderPass(simMat, positions.write);
    positions.swap();

    pointsMat.uniforms.uPosition.value = positions.read.texture;
    pointsMat.uniforms.uTime.value = elapsed;

    renderer.setRenderTarget(null);
    renderer.setViewport(0, 0, renderer.domElement.width, renderer.domElement.height);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
  }
})();
