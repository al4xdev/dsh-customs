import { sdk } from './sdk.mjs';
import { refuse } from './registry.mjs';
const { defineTool } = await sdk('dsh-tools');
export const name = 'companion-download-file-tool';
export const inject = ['tools', 'fs', 'companionFileDownloads'];
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'download_file',
    description: 'Offer one PC file that the owner (human) asked for as a private browser download. The owner approves each file in a one-shot file-share card. Maximum 20 MiB; the link expires five minutes after it is created. Known credential stores, keys, shell histories and private profiles are refused; never offer such files anyway. No automatic retries.',
    parameters: { path: { type: 'string', required: true, description: 'Exact regular PC file the owner (human) requested; relative to the current Session workspace. Not a folder, URL or glob.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { download: {
        type: 'object', required: true, additionalProperties: false, properties: {
          url: { type: 'string', required: true }, displayName: { type: 'string', required: true }, bytes: { type: 'integer', required: true }, expiresAt: { type: 'integer', required: true },
        },
      } } },
      render(_args, value) {
        const file = value.download;
        return [{ type: 'text', text: `[Baixar ${file.displayName}](${file.url}) · ${file.bytes} bytes · válido até ${new Date(file.expiresAt).toISOString()}. Link privado de um arquivo; não compartilhe.` }];
      },
    },
    async execute(args, exec) {
      // Never accept owner/session/approval fields through tool arguments, even if a
      // caller bypasses model-facing JSON Schema validation in another SDK mode.
      if (!args || Object.keys(args).length !== 1 || typeof args.path !== 'string') refuse('invalid-arguments');
      return { download: await ctx.get('companionFileDownloads').prepare(ctx, exec, args.path) };
    },
  }));
}
