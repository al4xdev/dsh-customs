import { relative, resolve, sep } from 'node:path';

// DSH anchors the loader baseUrl at the profile directory, and module names and
// include paths starting with "./" or "../" resolve against it. A profile-relative
// spelling stays valid on a machine whose HOME differs, as long as the repo and
// DSH_HOME keep the same layout below it (~/git/my/dsh-customs, ~/.dsh).
export function profileRelative(profileDir, target) {
  const path = relative(profileDir, target).split(sep).join('/');
  return path.startsWith('../') ? path : `./${path}`;
}

export const isProfileRelative = value => typeof value === 'string' && /^\.\.?\//.test(value);

export function resolveProfilePath(profileDir, value) {
  return isProfileRelative(value) ? resolve(profileDir, value) : value;
}
