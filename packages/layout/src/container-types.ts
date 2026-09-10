import { asBoolean } from "@godot-scene-web/core";
import type { IndexedNode } from "./types";

export function isBoxContainerType(type: string): boolean {
  return (
    type === "BoxContainer" ||
    type === "HBoxContainer" ||
    type === "VBoxContainer"
  );
}

export function boxContainerHorizontal(indexed: IndexedNode): boolean {
  if (indexed.node.type === "HBoxContainer") {
    return true;
  }
  if (indexed.node.type === "VBoxContainer") {
    return false;
  }
  return !(asBoolean(indexed.props.vertical) ?? false);
}

export function isFlowContainerType(type: string): boolean {
  return (
    type === "FlowContainer" ||
    type === "HFlowContainer" ||
    type === "VFlowContainer"
  );
}

export function flowContainerVertical(indexed: IndexedNode): boolean {
  if (indexed.node.type === "VFlowContainer") {
    return true;
  }
  if (indexed.node.type === "HFlowContainer") {
    return false;
  }
  return asBoolean(indexed.props.vertical) ?? false;
}
