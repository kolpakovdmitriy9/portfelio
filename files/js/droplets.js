/* Droplets — эффект «капли на стекле».
 * Ванильный порт React-компонента https://canvasui.dev/docs/components/droplets
 * WebGL2 + экспериментальный html-in-canvas API (Chrome 154+).
 * API: window.Droplets.supports(), window.Droplets.create(elements, options).
 */
(function () {
  'use strict';

  var canvasDimensionLimits = new WeakMap();

  /** Keep the existing DPR budget, then account for browser pinch zoom. */
  function getCanvasPixelRatio(element, context) {
    var scale = (window.visualViewport && window.visualViewport.scale) || 1;
    var requested = Math.min(window.devicePixelRatio || 1, 2) * scale;
    var width = Math.max(element.clientWidth, 1);
    var height = Math.max(element.clientHeight, 1);
    var maxDimension = 8192;
    if (context) {
      var limit = canvasDimensionLimits.get(context);
      if (limit === undefined) {
        limit = Math.min(
          maxDimension,
          context.getParameter(context.MAX_TEXTURE_SIZE),
          context.getParameter(context.MAX_RENDERBUFFER_SIZE)
        );
        canvasDimensionLimits.set(context, limit);
      }
      maxDimension = limit;
    }
    return Math.min(
      requested,
      maxDimension / Math.max(width, height),
      Math.sqrt(16777216 / (width * height))
    );
  }

  /** Pinch zoom changes visualViewport without resizing the element's CSS box. */
  function createCanvasResizeObserver(onResize) {
    var viewport = window.visualViewport;
    var frame = 0;
    var disconnected = false;
    var schedule = function () {
      if (frame || disconnected) return;
      frame = requestAnimationFrame(function () {
        frame = 0;
        onResize();
      });
    };
    var observer = new ResizeObserver(schedule);
    window.addEventListener('resize', schedule, { passive: true });
    if (viewport) viewport.addEventListener('resize', schedule, { passive: true });
    return {
      observe: function (element, options) { observer.observe(element, options); },
      unobserve: function (element) { observer.unobserve(element); },
      disconnect: function () {
        disconnected = true;
        observer.disconnect();
        cancelAnimationFrame(frame);
        window.removeEventListener('resize', schedule);
        if (viewport) viewport.removeEventListener('resize', schedule);
      }
    };
  }

  /**
   * Android can expose the API, but renderer crashes were reported on effect
   * pages (issue #50). Keep Android on the DOM/overlay fallback.
   */
  function isHtmlInCanvasBlocked() {
    var nav = navigator;
    var platform = nav.userAgentData && nav.userAgentData.platform;
    return platform === 'Android' || /Android/i.test(nav.userAgent);
  }

  /** Configure the capture subtree for both generations of the experimental API. */
  function prepareHtmlInCanvas(source, content) {
    if ('content' in source) {
      source.setAttribute('content', 'drawable');
      content.setAttribute('drawable', '');
    } else {
      source.setAttribute('layoutsubtree', '');
    }
  }

  /** Capture pixels and keep the native DOM hit-test region aligned with them. */
  function drawHtmlInCanvas(source, context, content) {
    var transform = context.drawElementImage(content, 0, 0);
    if (transform && typeof source.updateElementGeometry === 'function') {
      source.updateElementGeometry(content, { canvasTransform: transform });
    }
  }

  function createRectCache(element) {
    var current = element.getBoundingClientRect();

    var refresh = function () {
      current = element.getBoundingClientRect();
    };

    var observer = new ResizeObserver(refresh);
    observer.observe(element);
    window.addEventListener('resize', refresh, { passive: true });
    window.addEventListener('scroll', refresh, { capture: true, passive: true });

    return {
      get current() { return current; },
      destroy: function () {
        observer.disconnect();
        window.removeEventListener('resize', refresh);
        window.removeEventListener('scroll', refresh, true);
      }
    };
  }

  var DEFAULTS = {
    intensity: 0.5,
    speed: 1,
    scale: 0.4,
    dropWidth: 1,
    dropLength: 1,
    refraction: 0.2,
    blur: 0,
    vignette: 0,
    fallSpeed: 1,
    wiggle: 1,
    staticDrops: 0.2,
    interactive: true,
    interactionRadius: 0.3,
    interactionStrength: 0.6,
    interactionDistortion: 3,
    hoverOnly: false,
    tint: [1, 1, 1],
    tintStrength: 0
  };

  var VERT = '#version 300 es\n' +
'precision highp float;\n' +
'layout(location = 0) in vec2 aPos;\n' +
'out vec2 vUv;\n' +
'void main () {\n' +
'  vUv = aPos * 0.5 + 0.5;\n' +
'  gl_Position = vec4(aPos, 0.0, 1.0);\n' +
'}';

  var FRAG = '#version 300 es\n' +
'precision highp float;\n' +
'in vec2 vUv;\n' +
'out vec4 outColor;\n' +
'uniform sampler2D uContent;\n' +
'uniform vec2 uResolution;\n' +
'uniform vec2 uOffset;\n' +
'uniform float uTime;\n' +
'uniform float uIntensity;\n' +
'uniform float uScale;\n' +
'uniform float uDropWidth;\n' +
'uniform float uDropLength;\n' +
'uniform float uRefraction;\n' +
'uniform float uBlur;\n' +
'uniform float uVignette;\n' +
'uniform float uFallSpeed;\n' +
'uniform float uWiggle;\n' +
'uniform float uStaticDrops;\n' +
'uniform float uMaxX;\n' +
'uniform sampler2D uTrail;\n' +
'uniform float uWipe;\n' +
'uniform float uWipeDistort;\n' +
'uniform vec3 uTint;\n' +
'uniform float uTintStrength;\n' +
'uniform float uHasContent;\n' +
'\n' +
'#define S(a, b, t) smoothstep(a, b, t)\n' +
'\n' +
'vec3 N13 (float p) {\n' +
'  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.11369, 0.13787));\n' +
'  p3 += dot(p3, p3.yzx + 19.19);\n' +
'  return fract(vec3(\n' +
'    (p3.x + p3.y) * p3.z,\n' +
'    (p3.x + p3.z) * p3.y,\n' +
'    (p3.y + p3.z) * p3.x\n' +
'  ));\n' +
'}\n' +
'\n' +
'float N (float t) {\n' +
'  return fract(sin(t * 12345.564) * 7658.76);\n' +
'}\n' +
'\n' +
'float Saw (float b, float t) {\n' +
'  return S(0.0, b, t) * S(1.0, b, t);\n' +
'}\n' +
'\n' +
'float sdEgg (vec2 p, float ra, float rb) {\n' +
'  const float k = 1.7320508;\n' +
'  p.x = abs(p.x);\n' +
'  float r = ra - rb;\n' +
'  return ((p.y < 0.0) ? length(vec2(p.x, p.y)) - r :\n' +
'          (k * (p.x + r) < p.y) ? length(vec2(p.x, p.y - k * r)) :\n' +
'          length(vec2(p.x + r, p.y)) - 2.0 * r) - rb;\n' +
'}\n' +
'\n' +
'vec2 DropLayer (vec2 uv, float t) {\n' +
'  vec2 UV = uv;\n' +
'  vec2 a = vec2(6.0, 1.0);\n' +
'  vec2 grid = a * 2.0;\n' +
'\n' +
'  vec2 id = floor(uv * grid);\n' +
'  float gridFall = N(id.x) / 3.0 + 0.5;\n' +
'  uv.y += t * gridFall / a.y;\n' +
'  id = floor(uv * grid);\n' +
'  uv.y += N(id.x);\n' +
'\n' +
'  id = floor(uv * grid);\n' +
'  vec2 st = fract(uv * grid) - vec2(0.5, 0.0);\n' +
'  vec3 n = N13(id.x * 35.2 + id.y * 2376.1);\n' +
'\n' +
'  float x = n.x - 0.5;\n' +
'  float lambda = UV.y * 20.0;\n' +
'  float wiggle = sin(lambda + sin(lambda));\n' +
'  x += wiggle * (0.5 - abs(x)) * (n.z - 0.5) * uWiggle;\n' +
'  x *= 0.6;\n' +
'\n' +
'  float slowStart = 0.85;\n' +
'  float ti = fract(t * (gridFall + 0.1) + n.z);\n' +
'  float y = (Saw(slowStart, ti) - 0.5) * 0.9 + 0.5;\n' +
'  vec2 p = vec2(x, y);\n' +
'\n' +
'  float dropShape = (ti > slowStart)\n' +
'    ? -sin(6.2831853 * ti / (1.0 - slowStart)) * 0.5 - 0.5\n' +
'    : 0.0;\n' +
'  float d = sdEgg((st - p) * a.yx / vec2(uDropWidth, uDropLength), 0.0, dropShape);\n' +
'  float diameter = N(id.x + id.y) / 7.0 + 0.2;\n' +
'  float mainDrop = S(diameter / 1.5, 0.0, d);\n' +
'\n' +
'  float r2 = S(1.0, y, st.y);\n' +
'  float r = sqrt(r2);\n' +
'  float cd = abs(st.x - x);\n' +
'  float thickness = diameter * 0.95 * uDropWidth;\n' +
'  float trail = S(thickness * r, 0.0, cd);\n' +
'  float trailFront = S(-0.02, 0.02, st.y - y);\n' +
'  trail *= r2 * trailFront * 0.5;\n' +
'\n' +
'  y = UV.y;\n' +
'  float trail2 = S((thickness - 0.15) * r, 0.0, cd);\n' +
'  trail2 *= trailFront * n.z;\n' +
'  float rndX = N(id.x) / 1.5 + 0.5;\n' +
'  float rndY = N(st.y) / 40.0 + 0.05;\n' +
'  y = fract(y * 11.0 * rndX) + (st.y - 0.5);\n' +
'  float dd = length(st - vec2(x, y));\n' +
'  float droplets = S(trail2 + rndY, 0.0, dd);\n' +
'\n' +
'  float m = mainDrop + droplets * r * trailFront;\n' +
'  return vec2(m, trail);\n' +
'}\n' +
'\n' +
'float StaticDrops (vec2 uv, float t) {\n' +
'  uv *= 40.0;\n' +
'\n' +
'  vec2 id = floor(uv);\n' +
'  vec3 n = N13(id.x * 107.45 + id.y * 3543.654);\n' +
'  vec2 p = (n.xy - 0.5) * 0.6;\n' +
'  uv = fract(uv) - 0.5;\n' +
'\n' +
'  float d = length(uv - p);\n' +
'  float drop = S(0.3 * clamp(uDropWidth, 0.4, 1.4), 0.0, d);\n' +
'\n' +
'  float fade = Saw(0.1, fract(t + n.y));\n' +
'  float intensity = fract(n.x * 27.0);\n' +
'  return drop * fade * intensity;\n' +
'}\n' +
'\n' +
'vec2 Drops (vec2 uv, float t, float tFall, float l0, float l1, float l2, float wipe) {\n' +
'  float s = StaticDrops(uv, t) * l0 * (1.0 - wipe);\n' +
'  vec2 m1 = DropLayer(uv, tFall) * (l1 * (1.0 - wipe * 0.8));\n' +
'  vec2 m2 = DropLayer(uv * 1.85, tFall) * (l2 * (1.0 - wipe * 0.8));\n' +
'\n' +
'  float c = s + m1.x + m2.x;\n' +
'  c = S(0.3, 1.0, c);\n' +
'\n' +
'  return vec2(c, m1.y + m2.y);\n' +
'}\n' +
'\n' +
'void main () {\n' +
'  vec2 uv = vUv;\n' +
'\n' +
'  if (uv.x > uMaxX) {\n' +
'    outColor = vec4(0.0);\n' +
'    return;\n' +
'  }\n' +
'\n' +
'  vec2 aspectUv = (uv + uOffset - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);\n' +
'  float t = uTime * 0.2;\n' +
'  float dropScale = clamp(min(uResolution.x, uResolution.y) / 900.0, 0.75, 1.35) * uScale;\n' +
'  vec2 scaledUv = aspectUv * dropScale;\n' +
'\n' +
'  float rainAmount = clamp(uIntensity, 0.0, 1.25);\n' +
'\n' +
'  float staticDrops = S(-0.5, 1.0, rainAmount) * 2.0 * uStaticDrops;\n' +
'  float layer1 = S(0.25, 0.75, rainAmount);\n' +
'  float layer2 = S(0.0, 0.5, rainAmount);\n' +
'  float tFall = t * uFallSpeed;\n' +
'\n' +
'  float wipeMask = texture(uTrail, uv).r;\n' +
'  float wipe = wipeMask * clamp(uWipe, 0.0, 1.0);\n' +
'\n' +
'  vec2 c = Drops(scaledUv, t, tFall, staticDrops, layer1, layer2, wipe);\n' +
'\n' +
'  vec2 e = vec2(0.001, 0.0);\n' +
'  float cx = Drops(scaledUv + e, t, tFall, staticDrops, layer1, layer2, wipe).x;\n' +
'  float cy = Drops(scaledUv + e.yx, t, tFall, staticDrops, layer1, layer2, wipe).x;\n' +
'  vec2 normal = vec2(cx - c.x, cy - c.x);\n' +
'\n' +
'  vec2 e2 = vec2(0.012, 0.0);\n' +
'  float wx = texture(uTrail, uv + e2).r;\n' +
'  float wy = texture(uTrail, uv + e2.yx).r;\n' +
'  normal += vec2(wipeMask - wx, wipeMask - wy) * 0.05 * uWipeDistort * clamp(uWipe, 0.0, 1.0);\n' +
'\n' +
'  vec2 refractedUv = clamp(uv + normal * uRefraction, vec2(0.001), vec2(uMaxX - 0.004, 0.999));\n' +
'  float fog = clamp(uBlur, 0.0, 8.0) * mix(0.7, 1.0, rainAmount);\n' +
'  float back = fog * (1.0 - clamp(c.y * 2.0, 0.0, 1.0)) * (1.0 - wipe);\n' +
'  float focus = mix(back, 0.0, S(0.1, 0.2, c.x));\n' +
'\n' +
'  if (uHasContent < 0.5) {\n' +
'    float mask = S(0.02, 0.14, c.x);\n' +
'    vec3 n3 = normalize(vec3(normal * 42.0, 1.0));\n' +
'    vec3 L = normalize(vec3(-0.35, 0.75, 0.55));\n' +
'    float spec = pow(max(dot(reflect(vec3(0.0, 0.0, -1.0), n3), L), 0.0), 34.0);\n' +
'    float rim = clamp(length(normal) * 26.0, 0.0, 1.0);\n' +
'    vec3 dropCol = mix(vec3(0.72), uTint, clamp(uTintStrength, 0.0, 1.0));\n' +
'    vec3 colF = dropCol * (0.12 + 0.5 * rim) + vec3(spec);\n' +
'    float alphaF = mask * clamp(0.1 + rim * 0.5 + spec * 0.9, 0.0, 1.0);\n' +
'    outColor = vec4(clamp(colF, 0.0, 1.0) * alphaF, alphaF);\n' +
'    return;\n' +
'  }\n' +
'\n' +
'  vec4 content = textureLod(uContent, vec2(refractedUv.x, 1.0 - refractedUv.y), focus);\n' +
'  vec3 col = content.rgb;\n' +
'\n' +
'  col = mix(col, uTint, clamp(uTintStrength, 0.0, 1.0) * 0.35);\n' +
'\n' +
'  vec2 vignetteUv = uv - 0.5;\n' +
'  col *= 1.0 - dot(vignetteUv, vignetteUv) * clamp(uVignette, 0.0, 1.0) * 2.0;\n' +
'\n' +
'  outColor = vec4(col * content.a, content.a);\n' +
'}';

  var TRAIL_FRAG = '#version 300 es\n' +
'precision highp float;\n' +
'in vec2 vUv;\n' +
'out vec4 outColor;\n' +
'uniform sampler2D uPrev;\n' +
'uniform vec2 uFrom;\n' +
'uniform vec2 uTo;\n' +
'uniform float uAspect;\n' +
'uniform float uRadius;\n' +
'uniform float uDecay;\n' +
'uniform float uDrain;\n' +
'uniform float uSplat;\n' +
'\n' +
'float capsule (vec2 p, vec2 a, vec2 b) {\n' +
'  vec2 pa = p - a;\n' +
'  vec2 ba = b - a;\n' +
'  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);\n' +
'  return length(pa - ba * h);\n' +
'}\n' +
'\n' +
'void main () {\n' +
'  float prev = max(texture(uPrev, vUv).r * uDecay - uDrain, 0.0);\n' +
'  vec2 p = vec2(vUv.x * uAspect, vUv.y);\n' +
'  vec2 a = vec2(uFrom.x * uAspect, uFrom.y);\n' +
'  vec2 b = vec2(uTo.x * uAspect, uTo.y);\n' +
'  float d = capsule(p, a, b);\n' +
'  float m = smoothstep(uRadius, uRadius * 0.5, d) * uSplat;\n' +
'  outColor = vec4(max(prev, m), 0.0, 0.0, 1.0);\n' +
'}';

  function supportsHtmlInCanvas() {
    if (typeof document === 'undefined' || isHtmlInCanvasBlocked()) return false;
    var probe = document.createElement('canvas');
    var ctx = probe.getContext('2d');
    return Boolean(
      ctx &&
      typeof ctx.drawElementImage === 'function' &&
      typeof probe.requestPaint === 'function'
    );
  }

  /** @returns {{setOptions:Function, resize:Function, destroy:Function}|null} */
  function createDroplets(elements, options) {
    var config = Object.assign({}, DEFAULTS, options || {});
    var source = elements.source;
    var content = elements.content;
    var output = elements.output;

    var gl = output.getContext('webgl2', {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      premultipliedAlpha: true
    });
    if (!gl || gl.isContextLost()) return null;

    var sourceCtx = source.getContext('2d');
    var htmlInCanvas = Boolean(
      !isHtmlInCanvasBlocked() &&
      source.contains(content) &&
      sourceCtx &&
      typeof sourceCtx.drawElementImage === 'function' &&
      typeof source.requestPaint === 'function'
    );

    if (htmlInCanvas) prepareHtmlInCanvas(source, content);

    // Режим фонового изображения: фото рисуется в source-canvas через drawImage,
    // захват html-in-canvas не требуется (работает в любом WebGL2-браузере).
    var imageEl = null;
    var imageReady = false;

    function paintImage() {
      if (!imageReady || !sourceCtx) return;
      var w = source.width;
      var h = source.height;
      if (w < 2 || h < 2) return;
      sourceCtx.reset();
      var s = Math.max(w / imageEl.naturalWidth, h / imageEl.naturalHeight);
      var dw = imageEl.naturalWidth * s;
      var dh = imageEl.naturalHeight * s;
      sourceCtx.drawImage(imageEl, (w - dw) / 2, (h - dh) / 2, dw, dh);
      contentDirty = true;
      wake();
    }

    if (config.image) {
      imageEl = new Image();
      imageEl.onload = function () {
        imageReady = true;
        syncCanvasSize();
        paintImage();
      };
      imageEl.src = config.image;
    }

    var contentDirty = false;
    var wake = function () {};

    if (htmlInCanvas) {
      source.onpaint = function () {
        try {
          sourceCtx.reset();
          drawHtmlInCanvas(source, sourceCtx, content);
          contentDirty = true;
          wake();
        } catch (e) {}
      };
    }

    function compile(type, text) {
      var shader = gl.createShader(type);
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Droplets shader error:', gl.getShaderInfoLog(shader));
      }
      return shader;
    }

    var vertexShader = compile(gl.VERTEX_SHADER, VERT);
    var fragmentShader = compile(gl.FRAGMENT_SHADER, FRAG);
    var trailShader = compile(gl.FRAGMENT_SHADER, TRAIL_FRAG);

    function link(fragment) {
      var prog = gl.createProgram();
      gl.attachShader(prog, vertexShader);
      gl.attachShader(prog, fragment);
      gl.linkProgram(prog);
      var locations = {};
      var total = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      for (var i = 0; i < total; i++) {
        var info = gl.getActiveUniform(prog, i);
        locations[info.name] = gl.getUniformLocation(prog, info.name);
      }
      return { program: prog, uniforms: locations };
    }

    var linked = link(fragmentShader);
    var program = linked.program;
    var uniforms = linked.uniforms;
    var trailLinked = link(trailShader);
    var trailProgram = trailLinked.program;
    var trailUniforms = trailLinked.uniforms;

    var quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    var contentTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, contentTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0])
    );
    gl.generateMipmap(gl.TEXTURE_2D);

    var contentMaxX = 1;

    function syncCanvasSize() {
      var dpr = getCanvasPixelRatio(output, gl);
      var width = Math.max(1, Math.round(output.clientWidth * dpr));
      var height = Math.max(1, Math.round(output.clientHeight * dpr));
      if (output.width !== width || output.height !== height) {
        output.width = width;
        output.height = height;
      }
      contentMaxX = Math.min(
        1,
        Math.max(0.05, content.clientWidth / Math.max(output.clientWidth, 1))
      );
      if (htmlInCanvas || config.image) {
        var srcBox = htmlInCanvas ? source : output;
        var sourceWidth = Math.max(1, Math.round(srcBox.clientWidth * dpr));
        var sourceHeight = Math.max(1, Math.round(srcBox.clientHeight * dpr));
        if (source.width !== sourceWidth || source.height !== sourceHeight) {
          source.width = sourceWidth;
          source.height = sourceHeight;
        }
        if (htmlInCanvas) source.requestPaint();
      }
      paintImage();
    }

    syncCanvasSize();

    var trailWidth = 0;
    var trailHeight = 0;
    var trailTextures = [];
    var trailFramebuffers = [];
    var trailIndex = 0;

    function ensureTrailTargets() {
      var width = Math.max(1, Math.round(output.width / 4));
      var height = Math.max(1, Math.round(output.height / 4));
      if (width === trailWidth && height === trailHeight && trailTextures.length) return;
      trailWidth = width;
      trailHeight = height;
      trailTextures.forEach(function (t) { gl.deleteTexture(t); });
      trailFramebuffers.forEach(function (f) { gl.deleteFramebuffer(f); });
      trailTextures.length = 0;
      trailFramebuffers.length = 0;
      for (var i = 0; i < 2; i++) {
        var texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        var framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        trailTextures.push(texture);
        trailFramebuffers.push(framebuffer);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    var pointer = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, seen: false, moved: false };

    function updateTrail(delta) {
      ensureTrailTargets();
      gl.useProgram(trailProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, trailTextures[trailIndex]);
      gl.uniform1i(trailUniforms.uPrev, 0);
      gl.uniform1f(trailUniforms.uDecay, Math.exp(-delta * 0.5));
      gl.uniform1f(trailUniforms.uDrain, delta * 0.3);
      gl.uniform1f(trailUniforms.uAspect, output.width / Math.max(output.height, 1));
      gl.uniform2f(trailUniforms.uFrom, pointer.px, pointer.py);
      gl.uniform2f(trailUniforms.uTo, pointer.x, pointer.y);
      gl.uniform1f(trailUniforms.uRadius, Math.max(config.interactionRadius, 0.01));
      gl.uniform1f(trailUniforms.uSplat, config.interactive && pointer.moved ? 1 : 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, trailFramebuffers[1 - trailIndex]);
      gl.viewport(0, 0, trailWidth, trailHeight);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      trailIndex = 1 - trailIndex;
      pointer.px = pointer.x;
      pointer.py = pointer.y;
      pointer.moved = false;
    }

    function uploadContent() {
      if (!(htmlInCanvas || imageReady) || !contentDirty) return;
      contentDirty = false;
      gl.bindTexture(gl.TEXTURE_2D, contentTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    function render(timeSec) {
      uploadContent();
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, contentTexture);
      gl.uniform1i(uniforms.uContent, 0);
      gl.uniform1f(uniforms.uHasContent, (htmlInCanvas || imageReady) ? 1 : 0);
      gl.uniform2f(uniforms.uResolution, output.width, output.height);
      gl.uniform2f(
        uniforms.uOffset,
        content.scrollLeft / Math.max(content.clientWidth, 1),
        -content.scrollTop / Math.max(content.clientHeight, 1)
      );
      gl.uniform1f(uniforms.uTime, timeSec);
      gl.uniform1f(uniforms.uIntensity, config.intensity);
      gl.uniform1f(uniforms.uScale, Math.max(config.scale, 0.01));
      gl.uniform1f(uniforms.uDropWidth, Math.max(config.dropWidth, 0.05));
      gl.uniform1f(uniforms.uDropLength, Math.max(config.dropLength, 0.05));
      gl.uniform1f(uniforms.uRefraction, config.refraction);
      gl.uniform1f(uniforms.uBlur, Math.max(config.blur, 0));
      gl.uniform1f(uniforms.uVignette, config.vignette);
      gl.uniform1f(uniforms.uFallSpeed, config.fallSpeed);
      gl.uniform1f(uniforms.uWiggle, config.wiggle);
      gl.uniform1f(uniforms.uStaticDrops, config.staticDrops);
      gl.uniform1f(uniforms.uMaxX, contentMaxX);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, trailTextures[trailIndex]);
      gl.uniform1i(uniforms.uTrail, 1);
      gl.uniform1f(
        uniforms.uWipe,
        config.interactive
          ? Math.min(Math.max(config.interactionStrength, 0), 1)
          : 0
      );
      gl.uniform1f(uniforms.uWipeDistort, Math.max(config.interactionDistortion, 0));
      gl.uniform3f(uniforms.uTint, config.tint[0], config.tint[1], config.tint[2]);
      gl.uniform1f(uniforms.uTintStrength, config.tintStrength);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, output.width, output.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    var raf = 0;
    var lastTime = performance.now();
    var elapsed = 0;
    var destroyed = false;
    var running = false;
    var visible = true;
    // hoverOnly: капли идут только пока курсор внутри контейнера
    var active = !config.hoverOnly;

    var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    var reducedMotion = motionQuery.matches;

    function frame(now) {
      if (destroyed) return;
      if (!visible || !active) {
        running = false;
        return;
      }
      var delta = Math.min((now - lastTime) / 1000, 1 / 30);
      lastTime = now;
      elapsed += delta * config.speed;
      updateTrail(delta);
      render(elapsed);
      if (reducedMotion && !contentDirty) {
        running = false;
        return;
      }
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (destroyed || running || !visible || !active) return;
      running = true;
      lastTime = performance.now();
      raf = requestAnimationFrame(frame);
    }

    wake = start;
    start();

    function onMotionChange() {
      reducedMotion = motionQuery.matches;
      start();
    }
    if (motionQuery.addEventListener) motionQuery.addEventListener('change', onMotionChange);

    var observer = createCanvasResizeObserver(function () {
      syncCanvasSize();
      start();
    });
    observer.observe(output);
    observer.observe(content);

    var intersection = new IntersectionObserver(function (entries) {
      visible = entries[entries.length - 1] ? entries[entries.length - 1].isIntersecting : true;
      if (visible) start();
    });
    intersection.observe(output);

    var listenTarget = output.parentElement || output;

    var rectCache = createRectCache(output);

    function onPointerMove(event) {
      if (!config.interactive || reducedMotion) return;
      var rect = rectCache.current;
      var x = (event.clientX - rect.left) / Math.max(rect.width, 1);
      var y = 1 - (event.clientY - rect.top) / Math.max(rect.height, 1);
      if (!pointer.seen) {
        pointer.seen = true;
        pointer.px = x;
        pointer.py = y;
      }
      pointer.x = x;
      pointer.y = y;
      pointer.moved = true;
      start();
    }

    function onPointerLeave() {
      pointer.seen = false;
    }

    listenTarget.addEventListener('pointermove', onPointerMove, { passive: true });
    listenTarget.addEventListener('pointerleave', onPointerLeave, { passive: true });
    content.addEventListener('scroll', start, { passive: true });

    return {
      setActive: function (value) {
        active = Boolean(value);
        if (active) start();
      },
      setOptions: function (next) {
        var changed = Object.keys(next).some(function (key) {
          return config[key] !== next[key];
        });
        if (!changed) return;
        Object.assign(config, next);
        start();
      },
      resize: function () {
        syncCanvasSize();
        start();
      },
      destroy: function () {
        destroyed = true;
        rectCache.destroy();
        cancelAnimationFrame(raf);
        observer.disconnect();
        intersection.disconnect();
        if (motionQuery.removeEventListener) motionQuery.removeEventListener('change', onMotionChange);
        listenTarget.removeEventListener('pointermove', onPointerMove);
        listenTarget.removeEventListener('pointerleave', onPointerLeave);
        content.removeEventListener('scroll', start);
        gl.deleteTexture(contentTexture);
        trailTextures.forEach(function (t) { gl.deleteTexture(t); });
        trailFramebuffers.forEach(function (f) { gl.deleteFramebuffer(f); });
        gl.deleteProgram(program);
        gl.deleteProgram(trailProgram);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
        gl.deleteShader(trailShader);
        gl.deleteBuffer(quad);
        if (htmlInCanvas) source.onpaint = null;
      }
    };
  }

  window.Droplets = { create: createDroplets, supports: supportsHtmlInCanvas };
})();
