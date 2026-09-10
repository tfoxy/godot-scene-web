/** DrawList adapters for the DOM-free canvas-effects WebGL stage. */

import type {
  HeadlessGodotParticleDirectPass,
  HeadlessGodotParticleDirectRenderInput,
  HeadlessShaderProducer,
  HeadlessShaderRenderInput,
} from "@godot-scene-web/canvas-effects/webgl";
import type {
  ExternalEffectDrawCommand,
  ExternalEffectDrawContext,
  ScreenEffectDrawCommand,
  ScreenEffectDrawContext,
} from "./draw-list";

/** Bind a GPU screen producer at one DrawList painter position. */
export function createHeadlessScreenEffectCommand(
  producer: HeadlessShaderProducer,
  input: HeadlessShaderRenderInput,
): ScreenEffectDrawCommand {
  return {
    screenDependent: true,
    execute(context: ScreenEffectDrawContext) {
      return producer.renderScreen(input, context).ok;
    },
  };
}

/** Bind a direct GPU particle pass at one DrawList painter position. */
export function createHeadlessGodotParticleDirectEffect(
  pass: HeadlessGodotParticleDirectPass,
  input: HeadlessGodotParticleDirectRenderInput,
): ExternalEffectDrawCommand {
  return {
    execute(context: ExternalEffectDrawContext) {
      return pass.draw(input, context).ok;
    },
  };
}
