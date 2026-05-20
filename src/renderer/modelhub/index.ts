/**
 * Public Models Hub renderer surface.
 * See MODELS_HUB.md for the full plan (vision + task tracker + MCP dossier).
 */

export * from './types';
export * from './parsers';
export * from './autoTags';
export {
  useModelHeader,
  fetchModelHeader,
  _clearModelHeaderCache,
} from './useModelHeader';
export {
  useModelMeta,
  fetchModelMeta,
  enrichModelMeta,
  startBulkEnrichment,
  subscribeBulkEvents,
  _clearModelMetaCache,
  clearFolderBulk,
} from './useModelMeta';
export type {
  BulkProgressEvent,
  BulkDoneEvent,
  BulkSummary,
  BulkOptions,
  BulkRun,
} from './useModelMeta';
export {
  BulkEnrichmentContextProvider,
  useBulkEnrichment,
} from './BulkEnrichmentContext';
export { default as ModelhubSizeFilter } from './ModelhubSizeFilter';
export {
  buildModelhubTagGroup,
  upsertModelhubTagGroup,
  MODELHUB_TAGGROUP_UUID,
  MODELHUB_TAGGROUP_TITLE,
} from './modelhubTagGroup';
export type { HardwareProfile, RuntimeEstimate, GpuInfo } from './hardware';
export { fetchHardwareProfile, estimateRuntime } from './hardware';
export { default as RunModelButton } from './runners/RunModelButton';
export { default as RunnerSetupDialog } from './runners/RunnerSetupDialog';
export {
  useRunners,
  listRunners,
  saveRunner,
  removeRunner,
  detectRunners,
  autotuneFor,
  buildCommand,
  launchRunner,
  stopRunner,
  pickRunnerFor,
  quickLaunchModel,
  listRunningModels,
  openChatForPid,
} from './runners/useRunners';
