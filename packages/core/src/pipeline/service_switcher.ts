// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipecat: src/pipecat/pipeline/service_switcher.py

/**
 * Service switcher for switching between different services at runtime, with
 * different switching strategies.
 */

import {
  ErrorFrame,
  type Frame,
  ManuallySwitchServiceFrame,
  renewFrameIdentity,
  ServiceMetadataFrame,
  ServiceSwitcherFrame,
  ServiceSwitcherRequestMetadataFrame,
  ServiceUpdateSettingsFrame,
} from "../frames/frames.ts";
import { FunctionFilter } from "../processors/filters/function_filter.ts";
import { FrameDirection, type FrameProcessor } from "../processors/frame_processor.ts";
import { BaseObject } from "../utils/base_object.ts";
import { ErrorCategory } from "../utils/errors.ts";
import { logger } from "../utils/logger.ts";
import { ParallelPipeline } from "./parallel_pipeline.ts";

/**
 * Base class for service switching strategies.
 *
 * Note: strategy classes are instantiated internally by ServiceSwitcher.
 * Developers should pass the strategy class (not an instance) to
 * ServiceSwitcher.
 *
 * Event handlers available:
 *
 * - on_service_switched: called when the active service changes.
 *
 * @example
 * strategy.eventHandler("on_service_switched", async (strategy, service) => { ... });
 */
export class ServiceSwitcherStrategy extends BaseObject {
  protected _services: FrameProcessor[];
  protected _activeService: FrameProcessor;

  /**
   * Initialize the service switcher strategy with a list of services.
   *
   * Note: this is called internally by ServiceSwitcher. Do not instantiate
   * directly.
   *
   * @param services List of frame processors to switch between.
   */
  constructor(services: FrameProcessor[]) {
    super();

    if (services.length === 0) {
      throw new Error("ServiceSwitcherStrategy needs at least one service");
    }

    this._services = services;
    this._activeService = services[0] as FrameProcessor;

    this._registerEventHandler("on_service_switched");
  }

  /** The list of available services. */
  get services(): FrameProcessor[] {
    return this._services;
  }

  /** The currently active service. */
  get activeService(): FrameProcessor {
    return this._activeService;
  }

  /** The services that can still be given work, in order. */
  get usableServices(): FrameProcessor[] {
    return this._services.filter((service) => service.isUsable);
  }

  /**
   * Handle a frame that controls service switching.
   *
   * The base implementation returns null for all frames. Subclasses override
   * this to implement specific switching behaviors.
   *
   * @param frame The frame to handle.
   * @param direction The direction of the frame (upstream or downstream).
   * @returns The newly active service if a switch occurred, or null otherwise.
   */
  async handleFrame(
    _frame: ServiceSwitcherFrame,
    _direction: FrameDirection,
  ): Promise<FrameProcessor | null> {
    return null;
  }

  /**
   * Handle an error from the active service.
   *
   * Called by `ServiceSwitcher` for every `ErrorFrame` the active service
   * pushes upstream, whether or not the service can carry on from it.
   * Subclasses override this to decide which errors are worth switching away
   * from: `error.processor.isUsable` tells a service that is finished apart
   * from one having a bad moment, and a subclass is free to switch on either.
   *
   * @param error The error frame pushed by the active service.
   * @returns The newly active service if a switch occurred, or null otherwise.
   */
  async handleError(_error: ErrorFrame): Promise<FrameProcessor | null> {
    return null;
  }

  /**
   * Set the active service to the given one, if it is in the list of
   * available services.
   *
   * If it's not in the list, the request is ignored, as it may have been
   * intended for another ServiceSwitcher in the pipeline. A service that can
   * no longer do its job (`isUsable` false) is refused, since making it active
   * would only route work to something that can't handle it; call
   * `FrameProcessor.setUsable` on it first once whatever stopped it working
   * has been dealt with.
   *
   * @param service The service to set as active.
   * @returns The newly active service, or null if the service was not found
   *   or can no longer be given work.
   */
  protected async _setActiveIfAvailable(service: FrameProcessor): Promise<FrameProcessor | null> {
    if (!this.services.includes(service)) {
      return null;
    }

    if (!service.isUsable) {
      logger.warning(`Not switching to ${service.name}: it can no longer do its job`);
      return null;
    }

    this._activeService = service;
    await service.queueFrame(new ServiceSwitcherRequestMetadataFrame({ service }));
    await this._callEventHandler("on_service_switched", service);
    return service;
  }
}

/**
 * A strategy for switching between services manually.
 *
 * This strategy allows the user to manually select which service is active.
 * The initial active service is the first one in the list.
 *
 * @example
 * const sttSwitcher = new ServiceSwitcher([stt1, stt2], {
 *   strategyType: ServiceSwitcherStrategyManual,
 * });
 */
export class ServiceSwitcherStrategyManual extends ServiceSwitcherStrategy {
  /**
   * Handle a frame that controls service switching.
   *
   * @param frame The frame to handle.
   * @param direction The direction of the frame (upstream or downstream).
   * @returns The newly active service if a switch occurred, or null otherwise.
   */
  override async handleFrame(
    frame: ServiceSwitcherFrame,
    _direction: FrameDirection,
  ): Promise<FrameProcessor | null> {
    if (frame instanceof ManuallySwitchServiceFrame) {
      return await this._setActiveIfAvailable(frame.service);
    }

    return null;
  }
}

/**
 * A strategy that automatically switches to a backup service on failure.
 *
 * This strategy switches when the active service reports an error that leaves
 * it unable to do its job (`isUsable` false), moving to the next service in
 * the list that can still do its own. Errors the service can carry on from are
 * left alone, so a provider hiccup doesn't cost a failover. Recovery and
 * fallback policies are left to application code via the
 * `on_service_switched` event.
 *
 * Event handlers available:
 *
 * - on_service_switched: called when the active service changes.
 *
 * @example
 * const switcher = new ServiceSwitcher([primaryStt, backupStt], {
 *   strategyType: ServiceSwitcherStrategyFailover,
 * });
 *
 * switcher.strategy.eventHandler("on_service_switched", async (strategy, service) => {
 *   // App decides when/how to recover the failed service
 * });
 */
export class ServiceSwitcherStrategyFailover extends ServiceSwitcherStrategyManual {
  /**
   * Handle an error from the active service by failing over.
   *
   * Only an error that leaves the service unable to do its job is worth a
   * failover; anything it can carry on from is ignored. When one does,
   * switches to the next service in the list that can still do its job,
   * wrapping around from the end. The failed service stays in the list and can
   * be switched back to once it has been brought back with
   * `FrameProcessor.setUsable`.
   *
   * @param error The error frame pushed by the active service.
   * @returns The newly active service if a switch occurred, or null if the
   *   error didn't warrant one or no other service can be given work.
   */
  override async handleError(error: ErrorFrame): Promise<FrameProcessor | null> {
    const failedService = error.processor ?? this._activeService;

    // The service is still working, so there is nothing to fail over from.
    if (failedService.isUsable) {
      return null;
    }

    logger.warning(`Service ${failedService.name} reported an error: ${error.error}`);

    // Walk the list from the one after the active service so failover follows
    // the order the services were given in.
    const currentIdx = this._services.indexOf(this._activeService);
    for (let offset = 1; offset < this._services.length; offset++) {
      const candidate = this._services[
        (currentIdx + offset) % this._services.length
      ] as FrameProcessor;
      if (candidate.isUsable) {
        return await this._setActiveIfAvailable(candidate);
      }
    }

    logger.error("No other service available to switch to");
    return null;
  }
}

/** A strategy class, as passed to `ServiceSwitcher`. */
export type StrategyType<S extends ServiceSwitcherStrategy = ServiceSwitcherStrategy> = new (
  services: FrameProcessor[],
) => S;

export interface ServiceSwitcherOptions<S extends ServiceSwitcherStrategy> {
  /**
   * The strategy class to use for switching between services. Defaults to
   * `ServiceSwitcherStrategyManual`.
   */
  strategyType?: StrategyType<S>;
}

// Upstream keeps a `deque(maxlen=64)`.
const INACTIVE_SERVICE_UPDATES_MAXLEN = 64;

/**
 * Parallel pipeline that routes frames to one active service at a time.
 *
 * Wraps each service in a pair of filters that gate frame flow based on which
 * service is currently active. Switching is controlled by
 * `ServiceSwitcherFrame` frames and delegated to a pluggable
 * `ServiceSwitcherStrategy`.
 *
 * `ServiceUpdateSettingsFrame` is the exception to the gating. A settings
 * update addressed to a member service (`service`) reaches it whether or not
 * it is active, and one marked `reachInactiveServices` reaches every member,
 * so whichever service becomes active later is already configured. Any other
 * settings update applies to the active service alone.
 *
 * @example
 * const switcher = new ServiceSwitcher([stt1, stt2]);
 */
export class ServiceSwitcher<
  S extends ServiceSwitcherStrategy = ServiceSwitcherStrategyManual,
> extends ParallelPipeline {
  protected _services: FrameProcessor[];
  protected _strategy: S;
  // Ids of the settings updates handed to services that weren't active, so
  // they can be consumed again on their way out. A small ring is enough: an
  // update crosses its service long before the ring wraps.
  protected _inactiveServiceUpdates: number[] = [];
  // `isUsable` is read from the services, so keep the last value announced: a
  // service changing its own doesn't always change the switcher's.
  protected _announcedUsable: boolean;

  /**
   * Initialize the service switcher with a list of services and a switching strategy.
   *
   * @param services List of frame processors to switch between.
   * @param options.strategyType The strategy class to use for switching
   *   between services. Defaults to `ServiceSwitcherStrategyManual`.
   */
  constructor(services: FrameProcessor[], options: ServiceSwitcherOptions<S> = {}) {
    const strategyType = (options.strategyType ??
      ServiceSwitcherStrategyManual) as unknown as StrategyType<S>;
    const strategy = new strategyType(services);
    super(...ServiceSwitcher._makePipelineDefinitions(services, strategy));
    this._services = services;
    this._strategy = strategy;

    this._announcedUsable = this.isUsable;
    for (const service of services) {
      service.addEventHandler("on_usable_changed", (s: FrameProcessor, isUsable: boolean) =>
        this._onServiceUsableChanged(s, isUsable),
      );
    }
  }

  /**
   * Ignore an attempt to set this switcher's usability directly.
   *
   * A switcher has no usability of its own to set: what it reports is a
   * reading of its services. Bring an individual service back with its own
   * `FrameProcessor.setUsable`, which brings the switcher back with it.
   *
   * @param isUsable Whether the switcher can be given work. Ignored.
   */
  override async setUsable(isUsable: boolean): Promise<void> {
    // Not calling super: it would set a flag this switcher never reads, and
    // announce a change that didn't happen.
    logger.debug(
      `${this}: ignoring set_usable(${isUsable}); a switcher reports whether any of ` +
        "its services can be given work",
    );
  }

  /**
   * Announce this switcher's usability after a service changed its own.
   *
   * @param service The service whose usability changed.
   * @param isUsable Whether that service can now be given work.
   */
  protected async _onServiceUsableChanged(
    _service: FrameProcessor,
    _isUsable: boolean,
  ): Promise<void> {
    await this._announceUsable();
  }

  /** Raise `on_usable_changed` if what this switcher reports has moved. */
  protected async _announceUsable(): Promise<void> {
    const isUsable = this.isUsable;
    if (isUsable === this._announcedUsable) {
      return;
    }

    this._announcedUsable = isUsable;
    logger.debug(`${this}: ${isUsable ? "usable" : "no longer usable"}`);
    await this._callEventHandler("on_usable_changed", isUsable);
  }

  /** The active switching strategy. */
  get strategy(): S {
    return this._strategy;
  }

  /** The list of available services. */
  get services(): FrameProcessor[] {
    return this._services;
  }

  /**
   * Whether any of the switched services can still be given work.
   *
   * A switcher is only as dead as its last service: it can keep doing its job
   * by moving work to a different one, so it reports itself unusable only once
   * none of them can do theirs. This is a reading of the services rather than
   * a state of its own, so bringing a service back with
   * `FrameProcessor.setUsable` brings the switcher back too, and calling that
   * on the switcher itself does nothing. The switcher raises
   * `on_usable_changed` for itself as the reading moves, so watching it is
   * enough to hear about the services it holds.
   *
   * @returns True while at least one service can be given work.
   */
  override get isUsable(): boolean {
    return (this._services ?? []).some((service) => service.isUsable);
  }

  protected static _makePipelineDefinitions(
    services: FrameProcessor[],
    strategy: ServiceSwitcherStrategy,
  ): FrameProcessor[][] {
    const pipelines: FrameProcessor[][] = [];
    for (const service of services) {
      pipelines.push(ServiceSwitcher._makePipelineDefinition(service, strategy));
    }
    return pipelines;
  }

  protected static _makePipelineDefinition(
    service: FrameProcessor,
    strategy: ServiceSwitcherStrategy,
  ): FrameProcessor[] {
    const filter = async (_: Frame): Promise<boolean> => {
      return service === strategy.activeService;
    };

    // Layout: Filter → Service → Filter
    //
    // filterSystemFrames: we want to run filter functions also on system
    // frames.
    //
    // enableDirectMode: filter functions are quick so we don't need
    // additional tasks.
    return [
      new FunctionFilter({
        filter,
        direction: FrameDirection.DOWNSTREAM,
        filterSystemFrames: true,
        enableDirectMode: true,
      }),
      service,
      new FunctionFilter({
        filter,
        direction: FrameDirection.UPSTREAM,
        filterSystemFrames: true,
        enableDirectMode: true,
      }),
    ];
  }

  /**
   * Push a frame out of the service switcher.
   *
   * Suppresses `ServiceSwitcherRequestMetadataFrame` targeting the active
   * service (since it has already been handled) and `ServiceMetadataFrame`
   * from inactive services so only the active service's metadata reaches
   * downstream processors. One case this happens is with `StartFrame` since
   * all the filters let it pass, and `StartFrame` causes the service to
   * generate `ServiceMetadataFrame`.
   *
   * Also suppresses the copies of a `ServiceUpdateSettingsFrame` handed to
   * the inactive services, so that the update the rest of the pipeline sees
   * is the one travelling the active service's branch.
   *
   * `ErrorFrame` instances from the services being switched between are
   * answered for here rather than travelling on, since the rest of the
   * pipeline deals with the switcher and not with what it holds. Errors from
   * a service the switcher isn't using stop here outright. Every error from
   * the active service is forwarded to the strategy via `handleError`, which
   * decides whether it warrants a switch; a successful switch absorbs it, the
   * switcher having gone on doing its job. An error that leaves the active
   * service unable to do its job with no switch to be made is reported
   * against the switcher, so that the rest of the pipeline judges it by what
   * the switcher has left rather than by the one service that failed. Every
   * other error travels upstream as usual.
   */
  override async pushFrame(
    frame: Frame,
    direction: FrameDirection = FrameDirection.DOWNSTREAM,
  ): Promise<void> {
    // Consume ServiceSwitcherRequestMetadataFrame once the targeted service
    // has handled it (i.e. the active service).
    if (frame instanceof ServiceSwitcherRequestMetadataFrame) {
      if (frame.service === this.strategy.activeService) {
        return;
      }
    }

    // Only let metadata from the active service escape.
    if (frame instanceof ServiceMetadataFrame) {
      if (frame.serviceName !== this.strategy.activeService.name) {
        return;
      }
    }

    // Consume the settings updates handed to the inactive services: they have
    // been delivered, and only the active service's copy travels on.
    if (frame instanceof ServiceUpdateSettingsFrame) {
      if (this._inactiveServiceUpdates.includes(frame.id)) {
        return;
      }
    }

    // Errors from the switched services are the switcher's to answer for.
    // Errors from anywhere else are just passing through, and travel on.
    if (frame instanceof ErrorFrame && frame.processor !== null) {
      const failedService = frame.processor;
      const activeService = this.strategy.activeService;
      // A service the switcher isn't using can't stop it doing its job, so
      // its errors go no further. Watch a service's own `on_usable_changed`
      // to hear about the ones held in reserve.
      if (this._services.includes(failedService) && failedService !== activeService) {
        return;
      }
      if (failedService === activeService) {
        // The strategy decides which errors are worth switching away from. A
        // switch means the switcher recovered on its own, so the error goes no
        // further.
        if (await this.strategy.handleError(frame)) {
          return;
        }
        // No switch was made. If the service can no longer work, the switcher
        // has nowhere left to send the work, so it reports the failure as its
        // own. Any other error travels upstream.
        if (!failedService.isUsable) {
          await this._reportServiceFailure(failedService, frame);
          return;
        }
      }
    }

    await super.pushFrame(frame, direction);
  }

  /**
   * Report a service failure the switcher could not switch away from.
   *
   * Re-attributes the error to the switcher, which is the processor the rest
   * of the pipeline deals with. Whether losing this service matters depends
   * on what the switcher has left, not on the service that just failed, so
   * `isUsable` on the reported error answers for the switcher as a whole.
   *
   * @param failedService The service that can no longer do its job.
   * @param error The error it reported.
   */
  protected async _reportServiceFailure(
    failedService: FrameProcessor,
    error: ErrorFrame,
  ): Promise<void> {
    await this.pushError(`${failedService.name} can no longer do its job: ${error.error}`, {
      exception: error.exception,
      // A permanent category would cost the switcher its own `isUsable`,
      // writing it off along with the one service that failed.
      category: ErrorCategory.UNKNOWN,
    });
  }

  /**
   * Process a frame, handling frames which affect service switching.
   *
   * @param frame The frame to process.
   * @param direction The direction of the frame (upstream or downstream).
   */
  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    if (frame instanceof ServiceSwitcherFrame) {
      const service = await this.strategy.handleFrame(frame, direction);

      // If we don't switch to a new service we need to keep processing the
      // frame. If we switched, we just swallow the frame.
      if (!service) {
        await super.processFrame(frame, direction);
      }
    } else {
      await super.processFrame(frame, direction);

      if (frame instanceof ServiceUpdateSettingsFrame) {
        await this._updateInactiveServices(frame, direction);
      }
    }
  }

  /**
   * Hand a settings update to the member services that aren't active.
   *
   * The active service receives the update through its branch like any other
   * frame. The inactive ones sit behind closed filters, so each is handed its
   * own copy directly.
   *
   * @param frame The settings update to hand over.
   * @param direction The direction the settings update is travelling.
   */
  protected async _updateInactiveServices(
    frame: ServiceUpdateSettingsFrame,
    direction: FrameDirection,
  ): Promise<void> {
    for (const service of this._inactiveUpdateTargets(frame)) {
      // A copy carries the same update with an id of its own, which is how
      // pushFrame tells it from the active service's.
      const update = copyFrame(frame);
      this._inactiveServiceUpdates.push(update.id);
      if (this._inactiveServiceUpdates.length > INACTIVE_SERVICE_UPDATES_MAXLEN) {
        this._inactiveServiceUpdates.shift();
      }
      await service.queueFrame(update, direction);
    }
  }

  /**
   * Return the inactive member services that should apply a settings update.
   *
   * @param frame The settings update to route.
   * @returns The services to hand the update to, which may be empty.
   */
  protected _inactiveUpdateTargets(frame: ServiceUpdateSettingsFrame): FrameProcessor[] {
    const inactive = this.services.filter((s) => s !== this.strategy.activeService);

    // An addressed update goes to its service alone, active or not. One
    // addressed elsewhere in the pipeline is left for the switcher that
    // manages it.
    if (frame.service !== null) {
      return inactive.includes(frame.service) ? [frame.service] : [];
    }

    // Any other update crosses to the inactive services only if it opts in,
    // since settings values are often specific to one provider.
    return frame.reachInactiveServices ? inactive : [];
  }
}

/** `dataclasses.replace(frame)`: a shallow copy with a fresh `id` and `name`. */
function copyFrame<F extends Frame>(frame: F): F {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(frame)), frame) as F;
  renewFrameIdentity(clone);
  return clone;
}
