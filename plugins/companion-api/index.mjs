import { resolveHost } from '../common.mjs';
import { createCatalog } from './catalog.mjs';
import { createDeletion, deletionCodecs } from './deletion.mjs';
import { createModelSettings, modelCodecs, appModelCodecs } from './models.mjs';
import { createMessageHeads } from './message-heads.mjs';
import { messageHeadsCodecs } from './message-heads-contracts.mjs';
import * as catalogContracts from './contracts.mjs';
import { createCatalogActivity } from './activity-source.mjs';
import { createRecentCatalog } from './recent-catalog.mjs';
import { createInteractionHeads } from './interaction-heads.mjs';
import { interactionHeadsCodecs } from './interaction-heads-contracts.mjs';
import { catalogStateCodecs, parseCatalogState, parseCatalogStateRequest } from './catalog-state-contracts.mjs';
import { createCompanionLocalPolicy } from './companion-local-policy.mjs';
const { codecs, refusal } = catalogContracts;
const { TypertRemoteService } = await import(resolveHost('@deepseek-ai/dsh-typert-protocol'));
const { symbols } = await import(resolveHost('@deepseek-ai/cordis'));
const identityOf = value => value?.[symbols.original] ?? value;

export const name = 'companion-catalog-api';
export const inject = ['typert', 'sessionPersistence'];
export function assertCompanionProfile(ctx) {
  // The launcher publishes this public service via hostCtx.provide, not config.
  if (ctx.get('profileContext')?.name !== 'companion') throw refusal('profile-mismatch');
}
export function contribution() {
  return {
    package: 'dsh-customs-companion-api', face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      ['listChats', codecs.listRequest, codecs.listOutput],
      ['detail', codecs.detailRequest, codecs.detailOutput],
      ['deleteChat', deletionCodecs.request, deletionCodecs.output],
      ['modelCatalog', modelCodecs.modelCatalogRequest, modelCodecs.modelCatalogOutput],
      ['selectDefaultModel', modelCodecs.selectDefaultModelRequest, modelCodecs.selectDefaultModelOutput],
      ['messageHeads', messageHeadsCodecs.request, messageHeadsCodecs.output],
      ['selectAppModel', appModelCodecs.selectAppModelRequest, appModelCodecs.selectAppModelOutput],
      ['applyAppModel', appModelCodecs.applyAppModelRequest, appModelCodecs.applyAppModelOutput],
      ['catalogState', catalogStateCodecs.request, catalogStateCodecs.output],
      ['interactionHeads', interactionHeadsCodecs.request, interactionHeadsCodecs.output],
    ].map(([method, input, output]) => ({
      id: `companion/${method}`, service: 'companionCatalog', namespace: 'companion', method,
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: input }],
      cancellation: { parameter: 'signal' }, result: output,
    })),
  };
}
export class CompanionCatalogService extends TypertRemoteService {
  static inject = inject;
  constructor(ctx, options = {}) {
    assertCompanionProfile(ctx);
    super(ctx, 'companionCatalog', { namespace: 'companion' });
    this.activity = createCatalogActivity(ctx, { identityOf });
    this.catalog = createRecentCatalog(ctx.sessionPersistence, this.activity, createCatalog(ctx.sessionPersistence), catalogContracts);
    this.deletion = createDeletion(ctx.sessionPersistence);
    // Policy comes from the trusted project composition, never RPC arguments.
    // Missing local binding refuses local selections rather than probing a different server.
    this.models = createModelSettings(ctx, { appModelPolicy: options.localModelPolicy });
    if (options.localModelPolicy) ctx.inject(['agents', 'sessions', 'llm'], scoped => {
      options.localModelPolicy.installRequestPolicy(scoped);
    });
    this.messageMetadata = createMessageHeads(ctx, {}, { onActivity: metadata => this.activity.historicalHint(metadata) });
    this.interactionMetadata = createInteractionHeads(ctx, { sourceCurrent: () => this.activity.current() });
    ctx.effect(() => () => {
      this.interactionMetadata.close();
      this.messageMetadata.clear();
      this.catalog.close();
      this.activity.close();
    });
    // Public strict definitions own their fiber lifetime. Withdrawal fails closed
    // in the Gateway; no private interceptor, SRC marker or agent lookup is used.
    this.ctx.typert.register(contribution());
  }
  assertCurrent() {
    assertCompanionProfile(this.ctx);
    if (!this.activity.current()) throw refusal('metadata-unavailable');
  }
  listChats(request, signal) {
    this.assertCurrent();
    return this.catalog.listChats(request, signal);
  }
  detail(request, signal) {
    this.assertCurrent();
    return this.catalog.detail(request, signal);
  }
  async deleteChat(request, signal) {
    this.assertCurrent();
    if (!this.activity.current()) throw refusal('metadata-unavailable');
    const result = await this.deletion(request, signal);
    if (!this.activity.current()) throw refusal('metadata-unavailable');
    this.activity.noteCatalogMutation();
    return result;
  }
  async modelCatalog(request, signal) {
    this.assertCurrent();
    const result = await this.models.modelCatalog(request, signal);
    this.assertCurrent();
    return result;
  }
  async selectDefaultModel(request, signal) {
    this.assertCurrent();
    const result = await this.models.selectDefaultModel(request, signal);
    this.assertCurrent();
    return result;
  }
  selectAppModel(request, signal) {
    this.assertCurrent();
    return this.models.selectAppModel(request, signal, this.ctx);
  }
  applyAppModel(request, signal) {
    this.assertCurrent();
    return this.models.applyAppModel(request, signal, this.ctx);
  }
  catalogState(request, signal) {
    this.assertCurrent();
    parseCatalogStateRequest(request);
    signal?.throwIfAborted();
    const value = this.activity.state();
    if (value === null) throw refusal('metadata-unavailable');
    return parseCatalogState(value);
  }
  interactionHeads(request, signal) {
    this.assertCurrent();
    return this.interactionMetadata.read(request, signal);
  }
  async messageHeads(request, signal) {
    this.assertCurrent();
    const result = await this.messageMetadata.read(request, signal);
    this.assertCurrent();
    return result;
  }
}
export async function apply(ctx, options = {}) {
  assertCompanionProfile(ctx);
  // Binding is lazy and local-only. Ordinary catalog/Codex operations do not wait
  // for the optional provider or trigger discovery during this row's activation.
  // An unconfigured deployment must also fence native local requests: disabling
  // the picker alone would leave an older pinned route free to hit wrong weights.
  const localModelPolicy = options.localModelPolicy ?? createCompanionLocalPolicy(ctx, options.localModels ?? {});
  await ctx.plugin(CompanionCatalogService, { localModelPolicy });
}
