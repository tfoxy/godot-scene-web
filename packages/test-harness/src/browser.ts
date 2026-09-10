import type { DomTreeNode, TextRunMetric } from "./index";

export function collectDomTree(root: ParentNode = document): DomTreeNode[] {
  return [...root.querySelectorAll<HTMLElement>("[data-godot-path]")].map(
    (element) => {
      const rect = element.getBoundingClientRect();
      const parent =
        element.parentElement?.closest<HTMLElement>("[data-godot-path]");
      return {
        path: element.dataset.godotPath ?? "",
        name: element.dataset.godotName,
        type: element.dataset.godotType,
        parentPath: parent?.dataset.godotPath ?? null,
        // `visible` stays undefined: the renderer prunes hidden nodes instead of
        // attributing them (the layout-tree comparison still feeds real booleans
        // through `DomTreeNode.visible`).
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        textRuns: collectElementTextRuns(element),
      };
    },
  );
}

function collectElementTextRuns(
  element: HTMLElement,
): TextRunMetric[] | undefined {
  if (
    element.dataset.godotType !== "Label" &&
    element.dataset.godotType !== "RichTextLabel"
  ) {
    return undefined;
  }
  const textRoot =
    element.dataset.godotType === "RichTextLabel"
      ? (element.querySelector<HTMLElement>('[data-godot-rich-layer="fill"]') ??
        element)
      : element;
  const runs: TextRunMetric[] = [];
  const collect = (node: ChildNode, style: string): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (!text) {
        return;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      range.detach();
      runs.push({
        text,
        style,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
      return;
    }
    if (node instanceof HTMLElement) {
      const nodeStyle =
        node.tagName === "STRONG"
          ? "bold"
          : node.tagName === "EM"
            ? "italic"
            : style;
      for (const child of node.childNodes) {
        collect(child, nodeStyle);
      }
    }
  };
  for (const child of textRoot.childNodes) {
    collect(child, "");
  }
  return runs.length > 0 ? runs : undefined;
}
