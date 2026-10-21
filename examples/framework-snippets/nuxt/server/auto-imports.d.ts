// Nuxt generates these declarations from its auto-imports. This file lets the
// snippet typecheck without a Nuxt project.
import type {
  defineEventHandler as defineEventHandlerType,
  toWebRequest as toWebRequestType,
} from "h3";

declare global {
  const defineEventHandler: typeof defineEventHandlerType;
  const toWebRequest: typeof toWebRequestType;
}
