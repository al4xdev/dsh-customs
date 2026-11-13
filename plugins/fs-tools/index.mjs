// The stock filesystem tools (`@deepseek-ai/dsh-tool-fs`) with a Claude Code-shaped surface:
// one `read` that returns numbered lines for text and the image itself for PNG/JPEG/WebP/GIF,
// instead of `read` plus a separate `read_image`; `write` and `edit` unchanged.
//
// Why an adapter and not a fork: the stock package owns the windowed text read, the sandbox
// escalation, the observation events and the TUI cards, none of which needs to change.
// Only what the model sees changes, so the stock `apply` runs against a context whose
// `tools.register`, `systemPrompt.section` and `inject` are intercepted:
// - `read` is registered merged with `read_image`, which the stock plugin only defines while
//   the attachments service is mounted (inside `ctx.inject(['attachments'], …)`), so the image
//   half is bound late and drops out again when that service goes away;
// - the `tool:read` section ("Use the read tool — not shell commands like cat") is dropped: in
//   a bash-first preset the shell is the normal way to look at text;
// - the `tool:edit` section is dropped because it is no longer true: `alex-file-observation-coverage`
//   lets an edit through without a prior read (its exact context is the proof).
// Frontier models, trained on Claude Code, call their file reader for images and read text
// through the shell; in the reference Fable session all six `Read` calls were PNGs.
import { extname } from 'node:path';
import { intercept, resolveHost } from '../common.mjs';

const stock = await import(resolveHost('@deepseek-ai/dsh-tool-fs'));

export const name = 'alex-fs-tools';
export const inject = stock.inject;
export const Config = stock.Config;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const DROPPED_SECTIONS = new Set(['tool:read', 'tool:edit']);
export const READ_DESCRIPTION = 'Read a file. A text file returns line-numbered content (offset and limit page through a large one); a PNG/JPEG/WebP/GIF file returns the image itself, downscaled when large.';

export const isImagePath = path => typeof path === 'string' && IMAGE_EXTENSIONS.has(extname(path).toLowerCase());

/**
 * One `read` over the stock text and image readers. `imageTool()` returns the stock
 * `read_image` definition while it exists, else undefined.
 */
export function mergeRead(text, imageTool) {
  const pick = args => (isImagePath(args?.file_path) ? imageTool() : undefined);
  const imageOnly = args => ({ file_path: args.file_path });
  const merged = {
    ...text,
    description: READ_DESCRIPTION,
    output: {
      // Exactly one branch matches: the text value has no `image`, the image value no `lines`.
      schema: { oneOf: [text.output.schema, IMAGE_OUTPUT_SCHEMA] },
      render: (args, value) => (value?.image ? imageTool()?.output.render(imageOnly(args), value) ?? fallbackImageRender(value) : text.output.render(args, value)),
      presentationMeta: (args, value) => (value?.image ? imageTool()?.output.presentationMeta?.(imageOnly(args), value) ?? { path: value.path } : text.output.presentationMeta?.(args, value)),
    },
    async execute(args, exec) {
      if (!isImagePath(args?.file_path)) return text.execute(args, exec);
      const image = imageTool();
      if (!image) throw new Error(`cannot read "${args.file_path}" as an image: no attachment service is mounted`);
      return image.execute(imageOnly(args), exec);
    },
  };
  if (text.presentCall) merged.presentCall = args => (pick(args) ? pick(args).presentCall?.(imageOnly(args)) : text.presentCall(args));
  merged.presentResult = (args, result) => {
    const image = pick(args);
    if (image) return image.presentResult?.(imageOnly(args), result);
    return text.presentResult?.(args, result);
  };
  return merged;
}

// The stock read_image output (`{ path, image }`), as the registry's JSON Schema subset.
const IMAGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'image'],
  properties: {
    path: { type: 'string' },
    image: {
      type: 'object',
      additionalProperties: false,
      required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
      properties: {
        attachmentId: { type: 'string' },
        mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
        bytes: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        name: { type: 'string' },
        originalDimensions: {
          type: 'object',
          additionalProperties: false,
          required: ['width', 'height'],
          properties: { width: { type: 'integer' }, height: { type: 'integer' } },
        },
      },
    },
  },
};

// Only reachable if the image half went away between execute and render.
const fallbackImageRender = value => [{ type: 'text', text: `${value.path}: image (${value.image.width}x${value.image.height})` }];

export function apply(ctx, config) {
  let textRead, imageRead;
  const view = scope => {
    const tools = intercept(scope.tools, {
      register(definition) {
        if (definition.name === 'read_image') {
          imageRead = definition;
          // Its lifetime is the attachments service's: forget it with that scope.
          scope.effect(() => () => { if (imageRead === definition) imageRead = undefined; }, 'alex-fs-tools read_image binding');
          return () => { if (imageRead === definition) imageRead = undefined; };
        }
        if (definition.name === 'read') {
          textRead = definition;
          return scope.tools.register(mergeRead(textRead, () => imageRead));
        }
        return scope.tools.register(definition);
      },
    });
    const systemPrompt = intercept(scope.systemPrompt, {
      section(section) {
        if (DROPPED_SECTIONS.has(section.name)) return () => {};
        return scope.systemPrompt.section(section);
      },
    });
    return intercept(scope, {
      tools,
      systemPrompt,
      inject: (deps, callback, ...rest) => scope.inject(deps, child => callback(view(child)), ...rest),
    });
  };
  return stock.apply(view(ctx), config);
}
