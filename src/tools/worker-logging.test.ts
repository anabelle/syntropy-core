import { describe, it, expect, beforeEach } from 'bun:test';

describe('Worker Event Logging', () => {
  let WorkerCore: any;

  beforeEach(async () => {
    WorkerCore = await import('../worker-manager');
  });
  it('should read worker events from file', async () => {
    const store = await WorkerCore.readWorkerEvents();
    expect(store).toBeDefined();
    expect(store.version).toBe(1);
    expect(Array.isArray(store.events)).toBe(true);
  });

  it('should detect healing workers (running > 20 min)', async () => {
    const { healing, active } = await WorkerCore.detectHealingWorkers();
    expect(Array.isArray(healing)).toBe(true);
    expect(Array.isArray(active)).toBe(true);

    // healing should be a subset of active (or same)
    expect(healing.length).toBeLessThanOrEqual(active.length);
  });

  it('should have correct event structure', async () => {
    const store = await WorkerCore.readWorkerEvents();
    if (store.events.length > 0) {
      const event = store.events[0];
      expect(event).toHaveProperty('id');
      expect(event).toHaveProperty('taskId');
      expect(event).toHaveProperty('eventType');
      expect(event).toHaveProperty('timestamp');
    }
  });
});
