const { createBatchSender } = require('./batch-sender');

describe('createBatchSender', () => {
  let send;
  let batches;

  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
    send = jest.fn();
    batches = createBatchSender(send);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const advanceTo = (time) => jest.advanceTimersByTime(time - Date.now());

  it('sends the first collection on the next tick', () => {
    batches.add('payments');

    expect(send).not.toHaveBeenCalled();

    jest.advanceTimersByTime(0);

    expect(send).toHaveBeenCalledWith(['payments']);
  });

  it('holds collections found within 50 ms of a send for one batch while the first 4 batches go out', () => {
    batches.add('payments');
    advanceTo(20);
    batches.add('orders');
    advanceTo(40);
    batches.add('billing');
    advanceTo(49);

    expect(send.mock.calls).toEqual([[['payments']]]);

    advanceTo(50);

    expect(send.mock.calls).toEqual([[['payments']], [['orders', 'billing']]]);
  });

  it('sends the first 4 batches 50 ms apart and every later batch 250 ms apart', () => {
    const sentAt = [];
    send.mockImplementation(() => sentAt.push(Date.now()));
    const found = [];

    for (let time = 0; time <= 1000; time += 10) {
      advanceTo(time);
      found.push(time);
      batches.add(time);
    }
    advanceTo(1150);

    expect(sentAt).toEqual([0, 50, 100, 150, 400, 650, 900, 1150]);
    expect(send.mock.calls.flatMap(([collections]) => collections)).toEqual(found);
  });

  it('never holds a collection for more than 50 ms in the first 4 batches, or 250 ms in later ones', () => {
    const sentAt = [];
    send.mockImplementation(() => sentAt.push(Date.now()));

    [0, 10, 240, 260, 600, 601, 1000].forEach((time) => {
      advanceTo(time);
      batches.add(time);
    });
    advanceTo(1250);

    const waits = send.mock.calls.flatMap(([collections], index) =>
      collections.map((foundAt) => ({ wait: sentAt[index] - foundAt, limit: index < 4 ? 50 : 250 })));
    expect(waits).toHaveLength(7);
    waits.forEach(({ wait, limit }) => expect(wait).toBeLessThanOrEqual(limit));
  });

  it('sends what is left on flush and drops the timed send', () => {
    batches.add('payments');
    batches.flush();

    expect(send.mock.calls).toEqual([[['payments']]]);

    batches.add('orders');
    advanceTo(49);

    expect(send.mock.calls).toEqual([[['payments']]]);

    advanceTo(50);

    expect(send.mock.calls).toEqual([[['payments']], [['orders']]]);
  });

  it('sends nothing when nothing is waiting', () => {
    batches.flush();
    jest.advanceTimersByTime(1000);

    expect(send).not.toHaveBeenCalled();
  });
});
