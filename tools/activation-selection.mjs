// Isolated profiles require explicit opt-in even for future general-purpose
// plugins. Generic overlays deliberately keep their existing inclusion rules.
export function appliesToProfile(plugin, profile, manifest) {
  if (profile === null) return plugin.overlay !== false;
  if (plugin.profiles) return plugin.profiles.includes(profile);
  return !(manifest.isolatedProfiles ?? []).includes(profile);
}
