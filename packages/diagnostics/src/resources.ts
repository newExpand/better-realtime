import type { FlightRecorder } from "./recorder.ts";
import type { ResourceInventoryItem } from "./types.ts";
import { ProtocolStateMachine } from "@realtime/protocol/state-machines";

type Release = () => void | Promise<void>;

export class ResourceRegistry {
  #items = new Map<string, ResourceInventoryItem>();
  constructor(private readonly recorder: FlightRecorder) {}

  acquire(resourceType: string, ownerId: string, release: Release, bytes = 0): OwnedResource {
    const resourceId = `res_${crypto.randomUUID()}`;
    const item: ResourceInventoryItem = { resourceId, resourceType, ownerId, acquiredAt: new Date().toISOString(), state: "active", bytes };
    this.#items.set(resourceId, item);
    this.recorder.record({ kind: "resource.acquired", boundary: "resource.acquired", outcome: "success", component: "resource-registry", componentVersion: "0.1.0", resourceId, ownerId, details: { resourceType, bytes } });
    return new OwnedResource(item, release, this.#items, this.recorder);
  }

  inventory(): ResourceInventoryItem[] { return [...this.#items.values()].map((item) => ({ ...item })); }
  active(): ResourceInventoryItem[] { return this.inventory().filter((item) => item.state !== "released"); }
}

export class OwnedResource {
  #disposed = false;
  constructor(private readonly item: ResourceInventoryItem, private readonly release: Release, private readonly items: Map<string, ResourceInventoryItem>, private readonly recorder: FlightRecorder) {}

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.item.state = "releasing";
    this.recorder.record({ kind: "resource.release_requested", boundary: "resource.release_requested", outcome: "success", component: "resource-registry", componentVersion: "0.1.0", resourceId: this.item.resourceId, ownerId: this.item.ownerId });
    try {
      await this.release();
      this.item.state = "released";
      this.recorder.record({ kind: "resource.release_succeeded", boundary: "resource.release_succeeded", outcome: "success", component: "resource-registry", componentVersion: "0.1.0", resourceId: this.item.resourceId, ownerId: this.item.ownerId });
      this.items.delete(this.item.resourceId);
    } catch (error) {
      this.item.state = "failed";
      this.recorder.record({ kind: "resource.release_failed", boundary: "resource.release_failed", outcome: "failure", reasonCode: "RT_RESOURCE_RELEASE_FAILED", component: "resource-registry", componentVersion: "0.1.0", resourceId: this.item.resourceId, ownerId: this.item.ownerId, details: { error: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
  }
}

export class ResourceScope {
  readonly ownerId: string;
  readonly machine = new ProtocolStateMachine("resource_scope");
  #resources: OwnedResource[] = [];
  #disposePromise: Promise<void> | undefined;
  constructor(private readonly registry: ResourceRegistry, ownerId = `scope_${crypto.randomUUID()}`) { this.ownerId = ownerId; }

  acquire(resourceType: string, release: Release, bytes = 0): OwnedResource {
    if (this.machine.state !== "active") throw new Error("acquisition.rejected: scope is closing");
    const resource = this.registry.acquire(resourceType, this.ownerId, release, bytes);
    this.#resources.push(resource);
    return resource;
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeResources();
    return this.#disposePromise;
  }

  async #disposeResources(): Promise<void> {
    if (this.machine.state === "active") this.machine.transition("dispose");
    const errors: unknown[] = [];
    for (const resource of [...this.#resources].reverse()) {
      try { await resource.dispose(); } catch (error) { this.machine.transition("child_release_failed"); errors.push(error); }
    }
    this.#resources = [];
    if (errors.length > 0) throw new AggregateError(errors, "resource scope cleanup failed");
    this.machine.transition("children_released");
  }
}
