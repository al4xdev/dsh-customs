export const COMPANION_WORKSPACE_ROOT = '/home/alex/git/my/dsh-companion-workspace';
export const CONTROLLER_INPUT_CODE = 'companion/invalid-create-request';
export const CONTROLLER_PROFILE_CODE = 'companion/profile-mismatch';

const INPUT_MESSAGE = 'Companion creation requires only agentPreset: companion.';
const PROFILE_MESSAGE = 'Companion workspace controller requires the companion profile.';

// The runtime adapter supplies the native RemoteError; fake tests need no SDK.
export class ControllerPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function refuse(ErrorClass, code, message) {
  throw new ErrorClass(code, message, {});
}

function assertProfile(ctx, ErrorClass) {
  if (typeof ctx?.get !== 'function' || ctx.get('profileContext')?.name !== 'companion') {
    refuse(ErrorClass, CONTROLLER_PROFILE_CODE, PROFILE_MESSAGE);
  }
}

function assertCreateRequest(request, ErrorClass) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    refuse(ErrorClass, CONTROLLER_INPUT_CODE, INPUT_MESSAGE);
  }
  const prototype = Object.getPrototypeOf(request);
  const keys = Reflect.ownKeys(request);
  const preset = Object.getOwnPropertyDescriptor(request, 'agentPreset');
  if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== 1 || keys[0] !== 'agentPreset'
      || !preset || !Object.hasOwn(preset, 'value') || preset.value !== 'companion') {
    refuse(ErrorClass, CONTROLLER_INPUT_CODE, INPUT_MESSAGE);
  }
}

/** Preserve the native controller, metadata and lifecycle; specialize only create. */
export function createCompanionSessionController(BaseClass, ErrorClass = ControllerPolicyError) {
  return class CompanionSessionController extends BaseClass {
    constructor(ctx, ...args) {
      // Reject a misplaced profile before native constructor registration/effects.
      assertProfile(ctx, ErrorClass);
      super(ctx, ...args);
    }

    async create(request) {
      // Do not let native mkdir/adoption see client-selected paths or identities.
      assertCreateRequest(request, ErrorClass);
      return super.create({ agentPreset: 'companion', cwd: COMPANION_WORKSPACE_ROOT });
    }
  };
}
