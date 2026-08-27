/** Element creation, shortened. The only DOM helper worth having here. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/**
 * Adds or removes a bare attribute, touching the DOM only when it differs.
 *
 * The guard is the point. This runs over every programme row once a minute,
 * and writing an attribute that already has that value still invalidates the
 * element's style. Checking first means a minute in which nothing goes on air
 * costs no style recalculation and no layout at all.
 */
export function setFlag(node: Element, name: string, on: boolean): void {
  if (node.hasAttribute(name) === on) {
    return;
  }
  if (on) {
    node.setAttribute(name, '');
  } else {
    node.removeAttribute(name);
  }
}
