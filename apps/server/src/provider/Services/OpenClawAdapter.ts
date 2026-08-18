/**
 * OpenClawAdapter — shape type for the OpenClaw provider adapter.
 *
 * @module OpenClawAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface OpenClawAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
