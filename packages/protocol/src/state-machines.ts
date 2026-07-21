import inventory from "../../../spec/protocol/v1/state-machines.json" with { type: "json" };

export type MachineName = keyof typeof inventory.machines;
type Inventory = typeof inventory;

export class InvalidTransitionError extends Error {
  constructor(readonly machine: MachineName, readonly from: string, readonly event: string) {
    super(`Invalid ${machine} transition: ${from} --${event}--> ?`);
  }
}

export class ProtocolStateMachine {
  readonly name: MachineName;
  #state: string;

  constructor(name: MachineName, initial?: string) {
    this.name = name;
    const definition = inventory.machines[name];
    this.#state = initial ?? definition.initial;
    if (!definition.states.includes(this.#state as never)) throw new Error(`Unknown ${name} state: ${this.#state}`);
  }

  get state(): string { return this.#state; }

  can(event: string): boolean {
    const definition = inventory.machines[this.name];
    return definition.transitions.some((transition) => transition.from === this.#state && transition.on === event);
  }

  transition(event: string): { from: string; event: string; to: string; actions: readonly string[]; guards: readonly string[] } {
    const definition = inventory.machines[this.name];
    const candidate = definition.transitions.find((item) => item.from === this.#state && item.on === event);
    if (!candidate) throw new InvalidTransitionError(this.name, this.#state, event);
    const from = this.#state;
    this.#state = candidate.to;
    const guards = "guards" in candidate && Array.isArray(candidate.guards) ? candidate.guards as string[] : [];
    return { from, event, to: candidate.to, actions: candidate.actions, guards };
  }
}

export const stateMachineInventory: Inventory = inventory;
