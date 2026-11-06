// @godot-scene-web/input/pointer: the browser pointer capture (mouse, pen, touch, wheel; touch as
// mouse gestures in mode "mouse") and the DOM-free object-fit mapper it is usually given. A subpath
// of its own so the root entry never pulls capture code (docs/architecture.md). Spec:
// docs/input.md "Pointer".

export {
  createPointerCapture,
  type PointerCapture,
  type PointerCaptureMode,
  type PointerCaptureOptions,
  type PointerCaptureStats,
  type PointerDropReason,
  type PointerEventLike,
  type PointerEventTargetLike,
  type PointerStageLike,
  type PointerTargetsMode,
  type PointerVisibilitySource,
  type WheelEventLike,
} from "./pointer-capture";
export {
  objectFitMapper,
  type PointerBox,
  type PointerMap,
  type PointerObjectFit,
  type PointerObjectPosition,
  type PointerPoint,
  type PointerPresentationSize,
} from "./pointer-map";
export type {
  PointerGesture,
  PointerGestureDecision,
  PointerGestureKind,
  PointerGestureOptions,
} from "./pointer-mouse-mode";
