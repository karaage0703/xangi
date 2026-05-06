import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

interface ReceivedEvent {
  type: string;
  instance_id: string;
  host_hint: string;
  thread_id: string;
  turn_id: string;
  thread_label?: string;
  platform?: string;
  ts: number;
  [key: string]: unknown;
}

describe('events-emitter (pull-mode subscribers)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.XANGI_EVENTS_ENABLED;
    delete process.env.XANGI_INSTANCE_ID;
    delete process.env.DATA_DIR;
  });

  it('publishes a turn.started event with correct shape to subscribers', async () => {
    process.env.XANGI_INSTANCE_ID = 'xangi-test';
    const mod = await import('../src/events-emitter.js');
    const received: ReceivedEvent[] = [];
    mod.subscribeEvents((ev) => received.push(ev as ReceivedEvent));
    mod.events.turnStarted({
      threadId: 'discord:1',
      turnId: 'turn-1',
      threadLabel: '#general',
      platform: 'discord',
      userText: 'hello',
    });
    expect(received).toHaveLength(1);
    const ev = received[0];
    expect(ev.type).toBe('turn.started');
    expect(ev.instance_id).toBe('xangi-test');
    expect(typeof ev.host_hint).toBe('string');
    expect(ev.thread_id).toBe('discord:1');
    expect(ev.turn_id).toBe('turn-1');
    expect(ev.thread_label).toBe('#general');
    expect(ev.platform).toBe('discord');
    expect(ev.user_text).toBe('hello');
    expect(typeof ev.ts).toBe('number');
  });

  it('thread_label and platform are optional', async () => {
    const mod = await import('../src/events-emitter.js');
    const received: ReceivedEvent[] = [];
    mod.subscribeEvents((ev) => received.push(ev as ReceivedEvent));
    mod.events.turnStarted({ threadId: 't1', turnId: 'u1' });
    expect(received).toHaveLength(1);
    expect(received[0].thread_label).toBeUndefined();
    expect(received[0].platform).toBeUndefined();
  });

  it('uses XANGI_INSTANCE_ID verbatim when set explicitly', async () => {
    process.env.XANGI_INSTANCE_ID = 'xangi-prod';
    const mod = await import('../src/events-emitter.js');
    expect(mod.getEventsConfig().instanceId).toBe('xangi-prod');
    expect(mod.getEventsConfig().instanceIdSource).toBe('explicit');
  });

  it('auto-generates instance_id from hostname + DATA_DIR hash when unset', async () => {
    process.env.DATA_DIR = '/tmp/xangi-test-data-A';
    const modA = await import('../src/events-emitter.js');
    const idA = modA.getEventsConfig().instanceId;
    expect(idA).toMatch(/^xangi-.+-[0-9a-f]{6}$/);
    expect(modA.getEventsConfig().instanceIdSource).toBe('auto');

    // 別 DATA_DIR では別 ID になること
    vi.resetModules();
    process.env.DATA_DIR = '/tmp/xangi-test-data-B';
    const modB = await import('../src/events-emitter.js');
    const idB = modB.getEventsConfig().instanceId;
    expect(idB).not.toBe(idA);

    // 同じ DATA_DIR なら同じ ID
    vi.resetModules();
    process.env.DATA_DIR = '/tmp/xangi-test-data-A';
    const modA2 = await import('../src/events-emitter.js');
    expect(modA2.getEventsConfig().instanceId).toBe(idA);
  });

  it('publishes the normal-completion lifecycle in order', async () => {
    const { events, subscribeEvents } = await import('../src/events-emitter.js');
    const received: ReceivedEvent[] = [];
    subscribeEvents((ev) => received.push(ev as ReceivedEvent));
    const c = { threadId: 'discord:1', turnId: 'turn-2', platform: 'discord' as const };
    events.turnStarted(c);
    events.messageDelta({ ...c, chunk: 'a', fullText: 'a' });
    events.messageDelta({ ...c, chunk: 'b', fullText: 'ab' });
    events.turnComplete({ ...c, text: 'ab' });
    expect(received.map((e) => e.type)).toEqual([
      'turn.started',
      'message.delta',
      'message.delta',
      'turn.complete',
    ]);
  });

  it('publishes turn.aborted on cancel', async () => {
    const { events, subscribeEvents } = await import('../src/events-emitter.js');
    const received: ReceivedEvent[] = [];
    subscribeEvents((ev) => received.push(ev as ReceivedEvent));
    const c = { threadId: 'discord:1', turnId: 'turn-cancel' };
    events.turnStarted(c);
    events.messageDelta({ ...c, chunk: 'partial', fullText: 'partial' });
    events.turnAborted(c);
    expect(received.map((e) => e.type)).toEqual([
      'turn.started',
      'message.delta',
      'turn.aborted',
    ]);
  });

  it('publishes agent.error on exception', async () => {
    const { events, subscribeEvents } = await import('../src/events-emitter.js');
    const received: ReceivedEvent[] = [];
    subscribeEvents((ev) => received.push(ev as ReceivedEvent));
    const c = { threadId: 'discord:1', turnId: 'turn-err' };
    events.turnStarted(c);
    events.agentError({ ...c, message: 'boom' });
    expect(received).toHaveLength(2);
    expect(received[1].type).toBe('agent.error');
    expect(received[1].message).toBe('boom');
  });

  it('events for non-discord platforms (slack, web) work with same API', async () => {
    const mod = await import('../src/events-emitter.js');
    const received: ReceivedEvent[] = [];
    mod.subscribeEvents((ev) => received.push(ev as ReceivedEvent));
    mod.events.turnStarted({
      threadId: mod.threadIdFor('slack', 'C012345'),
      turnId: mod.turnIdFor('slack', '1700000000.000100'),
      threadLabel: '#general',
      platform: 'slack',
    });
    mod.events.turnStarted({
      threadId: mod.threadIdFor('web', 'session-abc'),
      turnId: mod.turnIdFor('web', '42'),
      threadLabel: 'Browser session',
      platform: 'web',
    });
    expect(received).toHaveLength(2);
    expect(received[0].thread_id).toBe('slack:C012345');
    expect(received[0].platform).toBe('slack');
    expect(received[0].thread_label).toBe('#general');
    expect(received[1].thread_id).toBe('web:session-abc');
    expect(received[1].platform).toBe('web');
  });

  it('does not publish when XANGI_EVENTS_ENABLED=false', async () => {
    process.env.XANGI_EVENTS_ENABLED = 'false';
    const { events, subscribeEvents } = await import('../src/events-emitter.js');
    const received: ReceivedEvent[] = [];
    subscribeEvents((ev) => received.push(ev as ReceivedEvent));
    events.turnStarted({ threadId: 'discord:1', turnId: 'turn-3' });
    expect(received).toHaveLength(0);
  });

  it('returns immediately and synchronously (does not block the caller)', async () => {
    const { events, subscribeEvents } = await import('../src/events-emitter.js');
    // 重い subscriber を 1 つ繋いでも publish は同期で帰ってくることを確認
    let counter = 0;
    subscribeEvents(() => {
      counter++;
      // (ここでブロッキング処理を書いたとしても publish 自体は呼んだら即帰る前提)
    });
    const start = Date.now();
    events.turnStarted({ threadId: 'discord:1', turnId: 'turn-5' });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(counter).toBe(1);
  });

  it('subscribeEvents returns an unsubscribe that stops further delivery', async () => {
    const { events, subscribeEvents } = await import('../src/events-emitter.js');
    const received: ReceivedEvent[] = [];
    const unsubscribe = subscribeEvents((ev) => received.push(ev as ReceivedEvent));
    events.turnStarted({ threadId: 'discord:1', turnId: 'turn-a' });
    unsubscribe();
    events.turnStarted({ threadId: 'discord:1', turnId: 'turn-b' });
    expect(received).toHaveLength(1);
    expect(received[0].turn_id).toBe('turn-a');
  });

  it('broadcasts the same payload to every subscriber (fan-out)', async () => {
    const { events, subscribeEvents, getSubscriberCount } = await import(
      '../src/events-emitter.js'
    );
    const a: ReceivedEvent[] = [];
    const b: ReceivedEvent[] = [];
    const c: ReceivedEvent[] = [];
    subscribeEvents((ev) => a.push(ev as ReceivedEvent));
    subscribeEvents((ev) => b.push(ev as ReceivedEvent));
    subscribeEvents((ev) => c.push(ev as ReceivedEvent));
    expect(getSubscriberCount()).toBe(3);
    events.turnStarted({ threadId: 'discord:1', turnId: 'turn-bc' });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(c).toHaveLength(1);
    expect(a[0].turn_id).toBe('turn-bc');
    expect(b[0].turn_id).toBe('turn-bc');
    expect(c[0].turn_id).toBe('turn-bc');
  });

  it('one subscriber throwing does not stop delivery to the others', async () => {
    const { events, subscribeEvents } = await import('../src/events-emitter.js');
    const a: ReceivedEvent[] = [];
    const b: ReceivedEvent[] = [];
    subscribeEvents(() => {
      throw new Error('subscriber boom');
    });
    subscribeEvents((ev) => a.push(ev as ReceivedEvent));
    subscribeEvents((ev) => b.push(ev as ReceivedEvent));
    expect(() =>
      events.turnStarted({ threadId: 'discord:1', turnId: 'turn-fanout' })
    ).not.toThrow();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('publish with zero subscribers is a no-op (does not throw)', async () => {
    const { events } = await import('../src/events-emitter.js');
    expect(() =>
      events.turnStarted({ threadId: 'discord:1', turnId: 'turn-empty' })
    ).not.toThrow();
  });

  it('threadIdFor / turnIdFor helpers', async () => {
    const mod = await import('../src/events-emitter.js');
    expect(mod.threadIdFor('discord', '123')).toBe('discord:123');
    expect(mod.threadIdFor('slack', 'C012')).toBe('slack:C012');
    expect(mod.threadIdFor('web', 'session-abc')).toBe('web:session-abc');
    expect(mod.turnIdFor('discord', '456')).toBe('discord-msg-456');
    expect(mod.turnIdFor('slack', '1700.000')).toBe('slack-msg-1700.000');
  });
});
