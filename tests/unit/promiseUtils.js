// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const { jsUnit: JsUnit } = imports;
const { Gio, GLib } = imports.gi;
const PromiseUtils = imports.misc.promiseUtils;

const PromiseResult = {
    RESOLVED: 0,
    FAILED: 1,
};

function executePromise(promise) {
    const promiseResult = {};

    promise.then(value => {
        promiseResult.result = PromiseResult.RESOLVED;
        promiseResult.value = value;
    }).catch(e => {
        promiseResult.result = PromiseResult.FAILED;
        promiseResult.error = e;
    });

    const loop = new GLib.MainLoop(null, false);
    while (promiseResult.result === undefined)
        loop.get_context().iteration(true);

    return promiseResult;
}

function assertResolved(promise, expected = undefined) {
    const promiseResult = executePromise(promise);

    if (promiseResult.error instanceof Error ||
        promiseResult.error instanceof GLib.Error)
        logError(promiseResult.error);
    else if (promiseResult.result !== PromiseResult.RESOLVED)
        logError(new Error(`Not a resolved result: ${promiseResult.error}`));

    JsUnit.assertEquals(PromiseResult.RESOLVED, promiseResult.result);
    JsUnit.assertUndefined(promiseResult.error);

    if (expected !== undefined)
        JsUnit.assertEquals(expected, promiseResult.value);

    return promiseResult.value;
}

function assertRejected(promise, expected = undefined) {
    const promiseResult = executePromise(promise);

    JsUnit.assertEquals(PromiseResult.FAILED, promiseResult.result);
    JsUnit.assertUndefined(promiseResult.value);

    if (expected !== undefined)
        JsUnit.assertEquals(expected, promiseResult.error);

    return promiseResult.error;
}

function testCase(name, test) {
    print(`Running test ${name}`);
    if (test.constructor.name === 'AsyncFunction')
        assertResolved(test());
    else
        test();
}

function assertPendingPromise(promise) {
    JsUnit.assertTrue(promise instanceof PromiseUtils.CancellablePromise);
    JsUnit.assertTrue(promise.pending());
    JsUnit.assertFalse(promise.cancelled());
    JsUnit.assertFalse(promise.rejected());
    JsUnit.assertFalse(promise.resolved());

    if (promise.cancellable) {
        JsUnit.assertTrue(
            !!GObject.signal_handler_find(promise.cancellable, {
                signalId: 'cancelled',
            }));
    }
}

function assertResolvedPromise(promise) {
    JsUnit.assertTrue(promise instanceof PromiseUtils.CancellablePromise);
    JsUnit.assertFalse(promise.pending());
    JsUnit.assertFalse(promise.cancelled());
    JsUnit.assertFalse(promise.rejected());
    JsUnit.assertTrue(promise.resolved());

    if (promise.cancellable) {
        JsUnit.assertEquals(0,
            GObject.signal_handler_find(promise.cancellable, {
                signalId: 'cancelled',
            }));
    }
}

function assertCancelledPromise(promise) {
    JsUnit.assertTrue(promise instanceof PromiseUtils.CancellablePromise);
    JsUnit.assertFalse(promise.pending());
    JsUnit.assertFalse(promise.resolved());
    JsUnit.assertTrue(promise.rejected());
    JsUnit.assertTrue(promise.cancelled());

    if (promise.cancellable) {
        JsUnit.assertEquals(0,
            GObject.signal_handler_find(promise.cancellable, {
                signalId: 'cancelled',
            }));
    }
}

function assertNotReached() {
    JsUnit.assertTrue(false);
}

async function assertCancelledPromiseAsync(promise) {
    try {
        await promise;
        assertNotReached();
    } catch (e) {
        JsUnit.assertTrue(e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
    }

    // We need to wait an idle cycle here as Promises have more priority than
    // other GSources and so we may not have yet disconnected from the 'cancelled'
    // signal.
    await new Promise(resolver => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        resolver();
        return GLib.SOURCE_REMOVE;
    }));

    assertCancelledPromise(promise);
}



testCase('CancellablePromise used as generic promise', async () => {
    assertResolved(new PromiseUtils.CancellablePromise(resolve => resolve(true)), true);
    assertRejected(new PromiseUtils.CancellablePromise((_resolve, reject) => reject(false)), false);

    JsUnit.assertEquals('success',
        await new PromiseUtils.CancellablePromise(resolve => resolve('success')));

    const rejecting = new PromiseUtils.CancellablePromise((_resolve, reject) => reject('got error'));
    try {
        await rejecting;
        assertNotReached();
    } catch (e) {
        JsUnit.assertEquals('got error', e);
    }
    JsUnit.assertFalse(rejecting.pending());
    JsUnit.assertFalse(rejecting.resolved());
    JsUnit.assertFalse(rejecting.cancelled());
    JsUnit.assertTrue(rejecting.rejected());
});

testCase('CancellablePromise with invalid cancellable', () => {
    JsUnit.assertRaises(() => new PromiseUtils.CancellablePromise(() => {}, {}));
});

testCase('CancellablePromise resolved state', async () => {
    const cancellable = new Gio.Cancellable();
    const promise = new PromiseUtils.CancellablePromise(resolve => resolve('yay!'), cancellable);
    JsUnit.assertEquals(cancellable, promise.cancellable);
    assertResolvedPromise(promise);
    JsUnit.assertEquals('yay!', await promise);
    JsUnit.assertEquals(cancellable, promise.cancellable);
});

testCase('CancellablePromise can be cancelled after being resolved', async () => {
    const cancellable = new Gio.Cancellable();
    const promise = new PromiseUtils.CancellablePromise(resolve => resolve('yay!'), cancellable);
    promise.cancel();
    JsUnit.assertEquals(cancellable, promise.cancellable);
    assertResolvedPromise(promise);
    JsUnit.assertEquals('yay!', await promise);
    JsUnit.assertEquals(cancellable, promise.cancellable);
});

testCase('CancellablePromise never resolved with delayed cancellation', async () => {
    const promise = new PromiseUtils.CancellablePromise(() => {});
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => promise.cancel());
    JsUnit.assertNull(promise.cancellable);
    assertPendingPromise(promise);

    await assertCancelledPromiseAsync(promise);
});

testCase('CancellablePromise used as promises chain', async () => {
    const promise = new PromiseUtils.CancellablePromise(resolve => resolve('first'));
    JsUnit.assertEquals('first second third',
        await promise.then(v => `${v} second`).then(v => `${v} third`));
});

testCase('CancellablePromise chain can be cancelled from last promise', async () => {
    const promise = new PromiseUtils.CancellablePromise(() => {}).then(
        () => {}).then(() => {}).then(() => {});
    promise.cancel();
    await assertCancelledPromiseAsync(promise);
});

testCase('CancellablePromise with non cancelled GCancellable', async () => {
    const cancellable = new Gio.Cancellable();
    const promise = new PromiseUtils.CancellablePromise(resolve => resolve('yay!'), cancellable);
    JsUnit.assertEquals(cancellable, promise.cancellable);
    assertResolvedPromise(promise);
    JsUnit.assertEquals('yay!', await promise);
    JsUnit.assertEquals(cancellable, promise.cancellable);
});

testCase('CancellablePromise with already cancelled GCancellable', async () => {
    const cancellable = new Gio.Cancellable();
    cancellable.cancel();
    const promise = new PromiseUtils.CancellablePromise(resolve => resolve(true), cancellable);
    JsUnit.assertEquals(cancellable, promise.cancellable);
    assertCancelledPromise(promise);

    await assertCancelledPromiseAsync(promise);
    JsUnit.assertEquals(cancellable, promise.cancellable);
});

testCase('CancellablePromise with delayed resolution', async () => {
    let resolver;
    const promise = new PromiseUtils.CancellablePromise(resolve => (resolver = resolve), new Gio.Cancellable());
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => resolver('late resolver!'));
    JsUnit.assertFalse(promise.cancellable.is_cancelled());
    assertPendingPromise(promise);

    JsUnit.assertEquals('late resolver!', await promise);

    JsUnit.assertFalse(promise.cancellable.is_cancelled());
    assertResolvedPromise(promise);
});

testCase('CancellablePromise never resolved with delayed GCancellable cancellation', async () => {
    const promise = new PromiseUtils.CancellablePromise(() => {}, new Gio.Cancellable());
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => promise.cancellable.cancel());
    JsUnit.assertFalse(promise.cancellable.is_cancelled());
    assertPendingPromise(promise);

    await assertCancelledPromiseAsync(promise);
    JsUnit.assertTrue(promise.cancellable.is_cancelled());
});

testCase('CancellablePromise with GCancellable never resolved with delayed cancellation', async () => {
    const promise = new PromiseUtils.CancellablePromise(() => {}, new Gio.Cancellable());
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => promise.cancel());
    JsUnit.assertFalse(promise.cancellable.is_cancelled());
    assertPendingPromise(promise);

    await assertCancelledPromiseAsync(promise);
    JsUnit.assertFalse(promise.cancellable.is_cancelled());
});

testCase('CancellablePromise GCancellable can be cancelled after being resolved', async () => {
    const promise = new PromiseUtils.CancellablePromise(resolve => resolve('yay!'), new Gio.Cancellable());
    JsUnit.assertFalse(promise.cancellable.is_cancelled());
    JsUnit.assertTrue(promise.resolved());

    promise.cancel = () => {
        throw Error('This must not be called now!');
    };
    promise.cancellable.cancel();

    JsUnit.assertTrue(promise.cancellable.is_cancelled());
    assertResolvedPromise(promise);
    JsUnit.assertEquals('yay!', await promise);
});

testCase('CancellablePromise chain can be cancelled from GCancellable', async () => {
    const promise = new PromiseUtils.CancellablePromise(() => {}, new Gio.Cancellable()).then(
        () => {}).then(() => {}).then(() => {});

    assertPendingPromise(promise);

    promise.cancellable.cancel();
    await assertCancelledPromiseAsync(promise);
    JsUnit.assertTrue(promise.cancellable.is_cancelled());
});

