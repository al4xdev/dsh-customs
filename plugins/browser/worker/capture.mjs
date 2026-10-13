import { randomUUID } from 'node:crypto';
import { stat, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import { fail } from '../errors.mjs';

const runFile = promisify(execFile);
const mime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
export function imageDimensions(bytes, format) {
  const data = Buffer.from(bytes);
  if (format === 'png' && data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (format === 'jpeg' && data[0] === 255 && data[1] === 216) {
    let offset = 2;
    const starts = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
    while (offset + 9 < data.length) {
      if (data[offset] !== 255) break;
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (starts.has(marker) && offset + 7 < data.length) return { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
      if (length < 2) break;
      offset += length;
    }
  }
  if (format === 'webp' && data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const codec = data.toString('ascii', 12, 16);
    if (codec === 'VP8X') return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
    if (codec === 'VP8 ') return { width: data.readUInt16LE(26) & 16383, height: data.readUInt16LE(28) & 16383 };
    if (codec === 'VP8L') { const bits = data.readUInt32LE(21); return { width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 }; }
  }
  fail('BACKEND_INVALID_OUTPUT', 'Screenshot dimensions could not be verified from its actual encoded image.');
}

export class CaptureManager {
  constructor({ config = {}, artifacts, targets, toolPaths = {} }) {
    this.config = config;
    this.limits = config.limits ?? {};
    this.artifacts = artifacts;
    this.targets = targets;
    this.toolPaths = toolPaths;
    this.captures = new Map();
    this.stopping = false;
  }
  metadata(record) { return { sessionId: record.session.sessionId, pageId: record.pageId, generation: record.session.generation }; }
  get(captureId, session) {
    const capture = this.captures.get(captureId);
    if (!capture || capture.session !== session || capture.generation !== session.generation) fail('STALE_HANDLE', 'Owned capture was not found in this context generation.');
    return capture;
  }
  checkConflict(session) {
    if (session.captures.size) fail('INVALID_STATE', 'Finalize the active video or trace before starting another recorder.');
  }
  async readiness(record, settings = {}) {
    const timeout = Math.min(settings.timeoutMs ?? this.limits.actionMs ?? 5000, this.limits.actionMs ?? 5000);
    if (settings.target) await this.targets.use(record, settings.target, target => target.waitForElementState('visible', { timeout }));
    if (settings.fonts) await record.page.waitForFunction(() => !document.fonts || document.fonts.status === 'loaded', undefined, { timeout });
    if (settings.images) await record.page.waitForFunction(() => Array.from(document.images).every(image => image.complete), undefined, { timeout });
  }
  async screenshot(record, args = {}) {
    const mode = args.mode ?? 'viewport';
    const format = args.format ?? 'png';
    const scale = args.scale ?? 'css';
    if (!mime[format]) fail('INVALID_ARGS', 'Screenshot format is unsupported.');
    if (!['viewport', 'fullPage', 'element'].includes(mode) || !['css', 'device'].includes(scale)) fail('INVALID_ARGS', 'Screenshot mode or scale is invalid.');
    if ((mode === 'element') !== Boolean(args.target) || (args.clip && mode !== 'viewport')) fail('INVALID_ARGS', 'Element mode requires its target; clips are viewport-only.');
    await this.readiness(record, args.readiness);
    const geometry = await record.page.evaluate(fullPage => ({ width: fullPage ? Math.max(innerWidth, document.documentElement.scrollWidth) : innerWidth, height: fullPage ? Math.max(innerHeight, document.documentElement.scrollHeight) : innerHeight, dpr: devicePixelRatio }), mode === 'fullPage');
    if (args.clip) {
      for (const key of ['x', 'y', 'width', 'height']) if (!Number.isFinite(args.clip[key])) fail('INVALID_ARGS', 'Screenshot clip coordinates must be finite CSS pixels.');
      if (args.clip.x < 0 || args.clip.y < 0 || args.clip.width <= 0 || args.clip.height <= 0 || args.clip.x + args.clip.width > geometry.width || args.clip.y + args.clip.height > geometry.height) fail('LIMIT_EXCEEDED', 'Screenshot clip lies outside its CSS viewport.');
      geometry.width = args.clip.width; geometry.height = args.clip.height;
    }
    if (mode === 'element') {
      const box = await this.targets.use(record, args.target, target => target.boundingBox());
      if (!box) fail('TARGET_NOT_FOUND', 'Screenshot target is not visible.');
      geometry.width = box.width; geometry.height = box.height;
    }
    const factor = scale === 'device' ? geometry.dpr : 1;
    if (geometry.width * geometry.height * factor ** 2 > (this.limits.pixels ?? 16_000_000) || (mode === 'fullPage' && geometry.height > 12000)) fail('LIMIT_EXCEEDED', 'Screenshot exceeds the rendered pixel/full-page limit. Use viewport, element or a smaller clip.');
    const mask = await Promise.all((args.maskTargets ?? []).map(target => this.targets.uniqueLocator(record, target)));
    const spec = { type: format, scale, timeout: args.timeoutMs ?? this.limits.actionMs ?? 5000, ...(mask.length ? { mask } : {}), ...(args.clip ? { clip: args.clip } : {}), ...(args.quality !== undefined ? { quality: args.quality } : {}) };
    let bytes;
    if (mode === 'element') bytes = await this.targets.use(record, args.target, target => target.screenshot(spec));
    else bytes = await record.page.screenshot({ ...spec, fullPage: mode === 'fullPage' });
    const dimensions = imageDimensions(bytes, format);
    if (dimensions.width * dimensions.height > (this.limits.pixels ?? 16_000_000)) fail('LIMIT_EXCEEDED', 'Actual encoded screenshot exceeds the pixel budget.');
    const artifact = await this.artifacts.write({ data: bytes, kind: 'screenshot', mime: mime[format], extension: format, ...this.metadata(record), ...dimensions });
    return { data: { mode, format, scale, coordinateSpace: 'css-viewport', cssViewport: record.page.viewportSize(), ...dimensions }, artifacts: [artifact] };
  }
  async startVideo(record, args = {}) {
    const session = record.session;
    if (this.stopping) fail('BACKEND_UNAVAILABLE', 'Capture runtime is closing.');
    this.checkConflict(session);
    if ([...this.captures.values()].some(item => item.kind === 'video' && ['starting', 'recording', 'stopping'].includes(item.state))) fail('LIMIT_EXCEEDED', 'Only one active video recorder is allowed for this worker owner.');
    if (args.scope && args.scope !== 'page') fail('UNSUPPORTED_CAPABILITY', 'This recorder is Page-scoped, not a context-wide MCP recorder.');
    if (typeof record.page.screencast?.start !== 'function') fail('UNSUPPORTED_CAPABILITY', 'This Playwright release does not provide Page-scoped video.');
    const fps = args.fps ?? 25;
    const duration = args.maxDurationMs ?? this.limits.videoDurationMs ?? 60000;
    if (!Number.isInteger(fps) || fps < 1 || fps > (this.limits.videoFps ?? 30) || !Number.isInteger(duration) || duration < 1000 || duration > (this.limits.videoDurationMs ?? 60000)) fail('LIMIT_EXCEEDED', 'Video FPS or duration exceeds the configured limits.');
    const viewport = record.page.viewportSize();
    const size = args.size ?? viewport;
    if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 2 || size.height < 2 || size.width > (this.limits.viewportWidth ?? 2560) || size.height > (this.limits.viewportHeight ?? 1440)) fail('LIMIT_EXCEEDED', 'Video size exceeds configured bounds.');
    const captureId = `bc_${randomUUID()}`;
    const artifact = await this.artifacts.reserve({ kind: 'video', mime: 'video/webm', extension: 'webm', ...this.metadata(record), captureId });
    const capture = { captureId, kind: 'video', state: 'starting', session, generation: session.generation, record, artifact, artifacts: [], warnings: [], fps, duration, size, timer: null, watcher: null, overlay: null, stopping: null, startedAt: Date.now() };
    let startFinished;
    capture.starting = new Promise(resolve => { startFinished = resolve; });
    this.captures.set(captureId, capture); session.captures.add(captureId);
    let started = false;
    try {
      await record.page.screencast.start({ path: artifact.path, size, fps });
      started = true;
      if (this.stopping || session.state !== 'ready') fail('CANCELLED', 'Session closed during capture startup.');
      if (args.cursor === true || args.cursorPreset === 'pointer') capture.overlay = await record.page.screencast.showActions({ cursor: 'pointer' });
      capture.state = 'recording';
      capture.timer = setTimeout(() => this.stop(captureId, session, { inspectFrames: true }).catch(() => {}), duration);
      capture.timer.unref();
      capture.watcher = setInterval(async () => {
        try { if ((await stat(artifact.path)).size > (this.limits.videoBytes ?? 100 * 1024 ** 2)) { capture.warnings.push({ code: 'LIMIT_EXCEEDED', message: 'Video exceeded the soft byte quota; auto-finalization was requested. Filesystem hard limits remain a separate boundary.' }); await this.stop(captureId, session, { inspectFrames: true }); } }
        catch (error) { if (error.code !== 'ENOENT') clearInterval(capture.watcher); }
      }, 500);
      capture.watcher.unref();
      return this.status(captureId, session);
    } catch (error) {
      if (started && !record.page.isClosed()) await record.page.screencast.stop().catch(() => {});
      await capture.overlay?.dispose().catch(() => {});
      capture.state = 'failed'; session.captures.delete(captureId);
      await this.artifacts.mark(artifact.artifactId, 'failed');
      throw error;
    } finally { startFinished(); }
  }
  async startTrace(session, args = {}) {
    if (this.stopping) fail('BACKEND_UNAVAILABLE', 'Capture runtime is closing.');
    this.checkConflict(session);
    if (args.format && args.format !== 'zip') fail('UNSUPPORTED_CAPABILITY', 'Trace output is a real ZIP, not a live MCP trace directory.');
    if (args.sources === true) fail('POLICY_DENIED', 'Source-code capture is disabled.');
    const captureId = `bc_${randomUUID()}`;
    const artifact = await this.artifacts.reserve({ kind: 'trace', mime: 'application/zip', extension: 'zip', sessionId: session.sessionId, generation: session.generation, captureId });
    const capture = { captureId, kind: 'trace', state: 'starting', session, generation: session.generation, artifact, artifacts: [], warnings: [], stopping: null, timer: null, watcher: null, startedAt: Date.now() };
    let startFinished;
    capture.starting = new Promise(resolve => { startFinished = resolve; });
    this.captures.set(captureId, capture); session.captures.add(captureId);
    let started = false;
    try {
      await session.context.tracing.start({ screenshots: args.screenshots === true, snapshots: args.snapshots === true, sources: false });
      started = true;
      if (this.stopping || session.state !== 'ready') fail('CANCELLED', 'Session closed during trace startup.');
      capture.state = 'recording';
      capture.timer = setTimeout(() => this.stop(captureId, session).catch(() => {}), this.limits.videoDurationMs ?? 60000);
      capture.timer.unref();
      return this.status(captureId, session);
    } catch (error) {
      if (started) await session.context.tracing.stop({ path: artifact.path }).catch(() => {});
      capture.state = 'failed'; session.captures.delete(captureId); await this.artifacts.mark(artifact.artifactId, 'failed'); throw error;
    } finally { startFinished(); }
  }
  status(captureId, session) {
    const capture = this.get(captureId, session);
    return { captureId, state: capture.state, scope: capture.kind === 'video' ? 'page' : 'context', ...(capture.record ? { pageId: capture.record.pageId } : {}), generation: capture.generation, ...(capture.kind === 'video' ? { requestedSize: capture.size, fps: capture.fps, maxDurationMs: capture.duration } : {}), artifacts: capture.artifacts.map(item => ({ ...item })), warnings: [...capture.warnings] };
  }
  tool(name) {
    const path = this.toolPaths[name];
    if (typeof path !== 'string' || !isAbsolute(path)) fail('BACKEND_UNAVAILABLE', `An administratively resolved ${name} binary is required to verify captured video.`);
    return path;
  }
  async inspectVideo(capture, args, signal) {
    const { stdout } = await runFile(this.tool('ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', capture.artifact.path], { timeout: this.limits.finalizeMs ?? 15000, maxBuffer: 1024 * 1024, signal });
    const metadata = JSON.parse(stdout);
    const stream = metadata.streams?.find(item => item.codec_type === 'video');
    const durationMs = Number(metadata.format?.duration) * 1000;
    if (!stream || !Number.isFinite(durationMs) || durationMs <= 0 || !Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height)) fail('BACKEND_INVALID_OUTPUT', 'Recorded video has no verified video stream, dimensions or duration.');
    const artifact = await this.artifacts.finalize(capture.artifact.artifactId, { width: stream.width, height: stream.height, durationMs });
    if (artifact.bytes > (this.limits.videoBytes ?? 100 * 1024 ** 2)) {
      await this.artifacts.mark(artifact.artifactId, 'partial');
      fail('LIMIT_EXCEEDED', 'Recorded video exceeds its byte limit.');
    }
    capture.artifacts.push(artifact);
    if (args.inspectFrames !== false) {
      for (const [index, ratio] of [[1, 0.1], [2, 0.5], [3, 0.9]]) {
        const frame = await this.artifacts.reserve({ kind: 'video-frame', mime: 'image/png', extension: 'png', ...this.metadata(capture.record), captureId: capture.captureId, frameIndex: index });
        try {
          await runFile(this.tool('ffmpeg'), ['-v', 'error', '-y', '-ss', String(durationMs / 1000 * ratio), '-i', capture.artifact.path, '-frames:v', '1', frame.path], { timeout: this.limits.finalizeMs ?? 15000, maxBuffer: 1024 * 1024, signal });
          capture.artifacts.push(await this.artifacts.finalize(frame.artifactId, { width: stream.width, height: stream.height }));
        } catch (error) { await this.artifacts.mark(frame.artifactId, 'failed'); throw error; }
      }
    }
  }
  async stop(captureId, session, args = {}, signal) {
    const capture = this.get(captureId, session);
    if (capture.stopping) return capture.stopping;
    if (['finalized', 'partial', 'failed'].includes(capture.state)) return this.status(captureId, session);
    capture.stopping = (async () => {
      await capture.starting;
      if (capture.state === 'failed') return this.status(captureId, session);
      capture.state = 'stopping'; clearTimeout(capture.timer); clearInterval(capture.watcher);
      let uncertainFlush = false;
      try {
        await capture.overlay?.dispose();
        if (capture.kind === 'video') {
          if (capture.record.page.isClosed()) uncertainFlush = true;
          else await capture.record.page.screencast.stop();
          await this.inspectVideo(capture, args, signal);
        } else {
          await session.context.tracing.stop({ path: capture.artifact.path });
          const file = await open(capture.artifact.path, 'r');
          const signature = Buffer.alloc(4);
          try { await file.read(signature, 0, 4, 0); } finally { await file.close(); }
          if (signature.toString('hex') !== '504b0304') fail('BACKEND_INVALID_OUTPUT', 'Trace is not a ZIP container.');
          capture.artifacts.push(await this.artifacts.finalize(capture.artifact.artifactId));
        }
        capture.state = uncertainFlush || capture.warnings.length ? 'partial' : 'finalized';
        if (uncertainFlush) capture.warnings.push({ code: 'PAGE_CLOSED', message: 'The recording page closed before an owned stop could confirm final flush; the video is partial even though its container was readable.' });
        if (capture.state === 'partial') {
          await this.artifacts.mark(capture.artifact.artifactId, 'partial');
          capture.artifacts = capture.artifacts.map(item => item.artifactId === capture.artifact.artifactId ? this.artifacts.inspect(item.artifactId) : item);
        }
      } catch (error) {
        capture.state = 'partial';
        await this.artifacts.mark(capture.artifact.artifactId, 'partial');
        capture.artifacts = this.artifacts.list().filter(item => item.captureId === capture.captureId);
        capture.warnings.push({ code: error.code ?? 'CAPTURE_FAILED', message: 'Capture did not fully finalize or pass verification. Inspect the partial owned artifacts; do not present them as a completed delivery.' });
      } finally { session.captures.delete(captureId); }
      return this.status(captureId, session);
    })();
    return capture.stopping;
  }
  async closePage(record) {
    const captures = [...record.session.captures].filter(id => this.captures.get(id)?.record === record);
    await Promise.all(captures.map(id => this.stop(id, record.session, { inspectFrames: false })));
  }
  async closeSession(session) {
    await Promise.all([...session.captures].map(id => this.stop(id, session, { inspectFrames: false })));
  }
  async close() {
    this.stopping = true;
    await Promise.all([...this.captures.values()].filter(item => ['recording', 'starting', 'stopping'].includes(item.state)).map(item => this.stop(item.captureId, item.session, { inspectFrames: false })));
  }
}
