import { randomUUID } from 'node:crypto'
import type { EventType, StreamEvent } from "@shared/types";


type Listener = (event: StreamEvent) => void;

export class EventChannel {
    public readonly streamId: string = randomUUID();
    private sequenceId: number = 1;
    private events: StreamEvent[] = [];
    private listeners: Set<Listener> = new Set();

    public subscribe(listener: Listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }


    public publish(eventType: EventType, payload: unknown = {}) {
        const event: StreamEvent = {
            id: this.sequenceId,
            streamId: this.streamId,
            type: eventType,
            payload
        };
        this.sequenceId++;
        this.events.push(event);
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (error) {
                this.listeners.delete(listener);
            }
        }
    }


    public replay(after: number) {

        return {
            events: this.events.filter((event) => event.id > after)
        }
    }

    get lastId() {
        return this.sequenceId - 1
    }

}