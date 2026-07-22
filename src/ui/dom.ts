/** Tiny DOM construction helpers (no framework needed for the probe UI). */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: ReadonlyArray<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}
