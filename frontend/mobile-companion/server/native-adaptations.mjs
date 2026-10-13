// This small, version-pinned presentation adaptation is confined to the copied
// browser artifact. Upstream transcript/parser/composer code and installed files
// remain untouched. rc.2 has no public capability switch for this footer action.
const forkAction = 'onBranch: () => {\n\t\t\t\t\t\tforkAt(data.seq);\n\t\t\t\t\t},';
export function adaptNativeChat(code) {
  const matches = code.split(forkAction).length - 1;
  if (matches !== 1) throw Error('Unsupported native chat footer: review the pinned Web adaptation');
  return code.replace(forkAction, 'onBranch: void 0,');
}
