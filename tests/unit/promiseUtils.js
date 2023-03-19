// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const { jsUnit: JsUnit, signals: Signals } = imports;
const { Gio, GLib, GObject } = imports.gi;
const Environment = imports.ui.environment;
const PromiseUtils = imports.misc.promiseUtils;

Environment.init();

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

function assertArrayEquals(array1, array2) {
    JsUnit.assertEquals(array1.length, array2.length);
    for (let j = 0; j < array1.length; j++)
        JsUnit.assertEquals(array1[j], array2[j]);
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

const SignalingGObject = GObject.registerClass({
    Signals: {
        'signal': {},
        'argument_signal': { param_types: [GObject.TYPE_STRING] },
        'arguments_signal': { param_types: [GObject.TYPE_STRING, GObject.TYPE_UINT] },
        'accumulator_signal': {
            accumulator: GObject.AccumulatorType.FIRST_WINS,
            return_type: GObject.TYPE_STRING,
            param_types: [GObject.TYPE_INT],
        },
    },
}, class SignalingObject extends GObject.Object {});

const SignalingGObjectWithDestroy = GObject.registerClass({
    Signals: { 'destroy': {} },
}, class SignalingGObjectWithDestroy extends SignalingGObject {});

class SignalingJSObject {}
Signals.addSignalMethods(SignalingJSObject.prototype);

testCase('SignalConnectionPromise with invalid object', () => {
    JsUnit.assertRaises(() => new PromiseUtils.SignalConnectionPromise({}, 'signal'));
});

testCase('SignalConnectionPromise with invalid signal name', () => {
    JsUnit.assertRaises(() => new PromiseUtils.SignalConnectionPromise(new SignalingGObject(),
        'not-existent-signal'));
});

testCase('SignalConnectionPromise for GObject simple signal', async () => {
    const gobject = new SignalingGObject();
    const promise = new PromiseUtils.SignalConnectionPromise(gobject, 'signal');
    const connectionId = GObject.signal_handler_find(promise.object, { signalId: 'signal' });

    JsUnit.assertEquals(gobject, promise.object);
    JsUnit.assertTrue(Number.isInteger(connectionId) && connectionId > 0);
    assertPendingPromise(promise);

    gobject.emit('signal');
    JsUnit.assertUndefined(await promise);
    assertResolvedPromise(promise);

    // Further emissions are ignored
    JsUnit.assertFalse(!!GObject.signal_handler_find(gobject, { signalId: 'signal' }));
    GLib.test_expect_message('GLib-GObject', GLib.LogLevelFlags.LEVEL_CRITICAL,
        `*instance '0x* has no handler with id '${connectionId}'*`);
    gobject.disconnect(connectionId);
    GLib.test_assert_expected_messages_internal('GLib-GObject', 'promiseUtils.js', 0,
        'SignalConnectionPromise for GObject simple signal');
});

testCase('SignalConnectionPromise for GObject argument_signal', async () => {
    const promise = new PromiseUtils.SignalConnectionPromise(new SignalingGObject(), 'argument_signal');
    assertPendingPromise(promise);

    promise.object.emit('argument_signal', 'hello!');
    JsUnit.assertEquals('hello!', await promise);
    assertResolvedPromise(promise);
});

testCase('SignalConnectionPromise for GObject arguments_signal', async () => {
    const promise = new PromiseUtils.SignalConnectionPromise(new SignalingGObject(),
        'arguments_signal');
    assertPendingPromise(promise);

    promise.object.emit('arguments_signal', 'hello!', 85);
    assertArrayEquals(['hello!', 85], await promise);
    assertResolvedPromise(promise);
});

testCase('SignalConnectionPromise for GObject is cancelled on cancel', async () => {
    const gobject = new SignalingGObject();
    const promise = new PromiseUtils.SignalConnectionPromise(gobject, 'signal');
    const connectionId = GObject.signal_handler_find(promise.object, { signalId: 'signal' });

    JsUnit.assertTrue(Number.isInteger(connectionId) && connectionId > 0);
    assertPendingPromise(promise);

    promise.cancel();
    JsUnit.assertNull(promise.object);
    gobject.emit('signal');
    await assertCancelledPromiseAsync(promise);

    // Further emissions are ignored
    JsUnit.assertFalse(!!GObject.signal_handler_find(gobject, { signalId: 'signal' }));
});

testCase('SignalConnectionPromise with already cancelled GCancellable', async () => {
    const gobject = new SignalingGObject();
    const cancellable = new Gio.Cancellable();
    cancellable.cancel();
    const promise = new PromiseUtils.SignalConnectionPromise(gobject, 'signal', cancellable);
    JsUnit.assertEquals(promise.object, gobject);
    JsUnit.assertEquals(0, GObject.signal_handler_find(promise.object, { signalId: 'signal' }));
    JsUnit.assertEquals(cancellable, promise.cancellable);
    assertCancelledPromise(promise);

    await assertCancelledPromiseAsync(promise);
    JsUnit.assertEquals(cancellable, promise.cancellable);
});

testCase('SignalConnectionPromise for GObject is cancelled on GCancellable cancellation', async () => {
    const gobject = new SignalingGObject();
    const promise = new PromiseUtils.SignalConnectionPromise(gobject, 'signal', new Gio.Cancellable());
    const connectionId = GObject.signal_handler_find(promise.object, { signalId: 'signal' });

    JsUnit.assertTrue(Number.isInteger(connectionId) && connectionId > 0);
    JsUnit.assertNotNull(promise.cancellable);
    assertPendingPromise(promise);

    promise.cancellable.cancel();
    JsUnit.assertNull(promise.object);
    gobject.emit('signal');
    await assertCancelledPromiseAsync(promise);

    // Further emissions are ignored
    JsUnit.assertFalse(!!GObject.signal_handler_find(gobject, { signalId: 'signal' }));
});

testCase('SignalConnectionPromise for GObject is cancelled on destroy', async () => {
    const gobject = new SignalingGObjectWithDestroy();
    const promise = new PromiseUtils.SignalConnectionPromise(gobject, 'signal');
    const connectionId = GObject.signal_handler_find(promise.object, { signalId: 'signal' });
    const destroyId = GObject.signal_handler_find(promise.object, { signalId: 'destroy' });

    JsUnit.assertTrue(Number.isInteger(connectionId) && connectionId > 0);
    JsUnit.assertNotUndefined(destroyId);
    assertPendingPromise(promise);

    gobject.emit('destroy');
    gobject.emit('signal');
    await assertCancelledPromiseAsync(promise);

    // Further emissions are ignored
    JsUnit.assertFalse(!!GObject.signal_handler_find(gobject, { signalId: 'signal' }));
    JsUnit.assertFalse(!!GObject.signal_handler_find(gobject, { signalId: 'destroy' }));
    GLib.test_expect_message('GLib-GObject', GLib.LogLevelFlags.LEVEL_CRITICAL,
        `*instance '0x* has no handler with id '${connectionId}'*`);
    GLib.test_expect_message('GLib-GObject', GLib.LogLevelFlags.LEVEL_CRITICAL,
        `*instance '0x* has no handler with id '${destroyId}'*`);
    gobject.disconnect(connectionId);
    gobject.disconnect(destroyId);
    GLib.test_assert_expected_messages_internal('GLib-GObject', 'promiseUtils.js', 0,
        'SignalConnectionPromise for GObject is cancelled on destroy');
});

testCase('SignalConnectionPromise for GObject works on destroy', async () => {
    const gobject = new SignalingGObjectWithDestroy();
    const promise = new PromiseUtils.SignalConnectionPromise(gobject, 'destroy');
    assertPendingPromise(promise);

    gobject.emit('destroy');
    await assertResolvedPromise(promise);
});

testCase('SignalConnectionPromise for GObject connect_once simple signal', async () => {
    const gobject = new SignalingGObject();
    const promise = gobject.connect_once('signal');

    assertPendingPromise(promise);
    gobject.emit('signal');
    JsUnit.assertUndefined(await promise);
    assertResolvedPromise(promise);
});

testCase('SignalConnectionPromise GObject connect_once argument_signal', async () => {
    const gobject = new SignalingGObject();
    const promise = gobject.connect_once('argument_signal');
    assertPendingPromise(promise);

    gobject.emit('argument_signal', 'hello!');
    JsUnit.assertEquals('hello!', await promise);

    assertResolvedPromise(promise);
});

testCase('SignalConnectionPromise GObject connect_once arguments_signal', async () => {
    const gobject = new SignalingGObject();
    const promise = gobject.connect_once('arguments_signal');
    assertPendingPromise(promise);

    gobject.emit('arguments_signal', 'hello!', 85);
    assertArrayEquals(['hello!', 85], await promise);
    assertResolvedPromise(promise);
});

testCase('SignalConnectionPromise GObject connect_once is cancelled on cancel', async () => {
    const gobject = new SignalingGObject();
    const promise = gobject.connect_once('signal');
    assertPendingPromise(promise);

    promise.cancel();
    gobject.emit('signal');
    await assertCancelledPromiseAsync(promise);
});

testCase('SignalConnectionPromise GObject connect_once is cancelled on GCancellable cancellation', async () => {
    const gobject = new SignalingGObject();
    const promise = gobject.connect_once('signal', new Gio.Cancellable());

    JsUnit.assertNotNull(promise.cancellable);
    assertPendingPromise(promise);

    promise.cancellable.cancel();
    gobject.emit('signal');
    await assertCancelledPromiseAsync(promise);
});

testCase('SignalConnectionPromise GObject connect_once is cancelled on destroy', async () => {
    const gobject = new SignalingGObjectWithDestroy();
    const promise = gobject.connect_once('signal');
    assertPendingPromise(promise);

    gobject.emit('destroy');
    gobject.emit('signal');
    await assertCancelledPromiseAsync(promise);
});

testCase('SignalConnectionPromise for JSObject simple signal', async () => {
    const object = new SignalingJSObject();
    const promise = new PromiseUtils.SignalConnectionPromise(object, 'signal');

    assertPendingPromise(promise);

    object.emit('signal');
    JsUnit.assertUndefined(await promise);
    assertResolvedPromise(promise);
});

testCase('SignalConnectionPromise for JSObject argument_signal', async () => {
    const object = new SignalingJSObject();
    const promise = new PromiseUtils.SignalConnectionPromise(object, 'argument_signal');
    assertPendingPromise(promise);

    object.emit('argument_signal', 'hello!');
    JsUnit.assertEquals('hello!', await promise);
    assertResolvedPromise(promise);
});

testCase('SignalConnectionPromise for JSObject arguments_signal', async () => {
    const object = new SignalingJSObject();
    const promise = new PromiseUtils.SignalConnectionPromise(object, 'arguments_signal');
    assertPendingPromise(promise);

    object.emit('arguments_signal', 'hello!', 85);
    assertArrayEquals(['hello!', 85], await promise);
    assertResolvedPromise(promise);
});

testCase('SignalConnectionPromise for JSObject is cancelled on cancel', async () => {
    const object = new SignalingJSObject();
    const promise = new PromiseUtils.SignalConnectionPromise(object, 'signal');
    assertPendingPromise(promise);

    promise.cancel();
    object.emit('signal');
    await assertCancelledPromiseAsync(promise);
});

testCase('SignalConnectionPromise for JSObject is cancelled on GCancellable cancellation', async () => {
    const object = new SignalingJSObject();
    const promise = new PromiseUtils.SignalConnectionPromise(object, 'signal', new Gio.Cancellable());
    JsUnit.assertNotNull(promise.cancellable);
    assertPendingPromise(promise);

    promise.cancellable.cancel();
    object.emit('signal');
    await assertCancelledPromiseAsync(promise);
});

testCase('SignalConnectionPromise for JSObject is cancelled on destroy', async () => {
    const object = new SignalingJSObject();
    const promise = new PromiseUtils.SignalConnectionPromise(object, 'signal');
    assertPendingPromise(promise);

    object.emit('destroy');
    object.emit('signal');
    await assertCancelledPromiseAsync(promise);
});

testCase('SignalConnectionPromise for JSObject works on destroy', async () => {
    const object = new SignalingJSObject();
    const promise = new PromiseUtils.SignalConnectionPromise(object, 'destroy');
    assertPendingPromise(promise);

    object.emit('destroy');
    await assertResolvedPromise(promise);
});

testCase('SignalConnectionPromise for JSObject connect_once simple signal', async () => {
    const object = new SignalingJSObject();
    const promise = object.connect_once('signal');

    assertPendingPromise(promise);
    object.emit('signal');
    JsUnit.assertUndefined(await promise);
    assertResolvedPromise(promise);
});

testCase('SignalConnectionPromise JSObject connect_once argument_signal', async () => {
    const object = new SignalingJSObject();
    const promise = object.connect_once('argument_signal');
    assertPendingPromise(promise);

    object.emit('argument_signal', 'hello!');
    JsUnit.assertEquals('hello!', await promise);
    assertResolvedPromise(promise);
});

testCase('SignalConnectionPromise JSObject connect_once arguments_signal', async () => {
    const object = new SignalingJSObject();
    const promise = object.connect_once('arguments_signal');
    assertPendingPromise(promise);

    object.emit('arguments_signal', 'hello!', 85);
    assertArrayEquals(['hello!', 85], await promise);
    assertResolvedPromise(promise);
});

testCase('SignalConnectionPromise JSObject connect_once is cancelled on cancel', async () => {
    const object = new SignalingJSObject();
    const promise = object.connect_once('signal');
    assertPendingPromise(promise);

    promise.cancel();
    object.emit('signal');
    await assertCancelledPromiseAsync(promise);
});

testCase('SignalConnectionPromise JSObject connect_once is cancelled on GCancellable cancellation', async () => {
    const object = new SignalingJSObject();
    const promise = object.connect_once('signal', new Gio.Cancellable());

    JsUnit.assertNotNull(promise.cancellable);
    assertPendingPromise(promise);

    promise.cancellable.cancel();
    object.emit('signal');
    await assertCancelledPromiseAsync(promise);
});

testCase('SignalConnectionPromise JSObject connect_once is cancelled on destroy', async () => {
    const object = new SignalingJSObject();
    const promise = object.connect_once('signal');
    assertPendingPromise(promise);

    object.emit('destroy');
    object.emit('signal');
    await assertCancelledPromiseAsync(promise);
});

testCase('SignalConnectionPromiseFull with resolving handler', async () => {
    const gobject = new SignalingGObject();
    const promise = new PromiseUtils.SignalConnectionPromiseFull(gobject,
        'signal', promiseHandler => promiseHandler.resolve('Hello!'));

    promise.object.emit('signal');
    JsUnit.assertEquals('Hello!', await promise);
});

testCase('SignalConnectionPromiseFull with rejecting handler', async () => {
    const gobject = new SignalingGObject();
    const promise = new PromiseUtils.SignalConnectionPromiseFull(gobject,
        'signal', promiseHandler => promiseHandler.reject('Good bye!'));

    promise.object.emit('signal');
    try {
        await promise;
        assertNotReached();
    } catch (e) {
        JsUnit.assertEquals('Good bye!', e);
    }
});

testCase('SignalConnectionPromiseFull with no handler', () => {
    const gobject = new SignalingGObject();
    const promise = new PromiseUtils.SignalConnectionPromiseFull(gobject,
        'signal', () => {});

    try {
        GLib.test_expect_message('Gjs', GLib.LogLevelFlags.LEVEL_CRITICAL,
            '*Promise was not resolved or rejected*');
        promise.object.emit('signal');
        GLib.test_assert_expected_messages_internal('Gjs', 'promiseUtils.js', 0,
            'SignalConnectionPromiseFull with no handler');
    } catch (e) {
        JsUnit.assertTrue(e.message.includes('Promise was not resolved or rejected'));
    }

    const e = assertRejected(promise);
    JsUnit.assertTrue(e.message.includes('Promise was not resolved or rejected'));
});

testCase('SignalConnectionPromiseFull with multiple handler', async () => {
    const gobject = new SignalingGObject();
    const promise = new PromiseUtils.SignalConnectionPromiseFull(gobject,
        'accumulator_signal', (handler, param) => {
            if (param > 100) {
                handler.resolve('Resolved value');
                return 'This is resolved';
            } else {
                return 'Ignored by promise';
            }
        }, PromiseUtils.SignalConnectionPromiseFull.Flags.MULTIPLE);

    JsUnit.assertEquals(
        'Ignored by promise', promise.object.emit('accumulator_signal', 10));
    JsUnit.assertEquals(
        'Ignored by promise', promise.object.emit('accumulator_signal', 20));

    JsUnit.assertEquals(
        'This is resolved', promise.object.emit('accumulator_signal', 150));
    JsUnit.assertEquals('Resolved value', await promise);
});

testCase('SignalConnectionPromiseFull with after resolving handler', async () => {
    const gobject = new SignalingGObject();
    const promise = new PromiseUtils.SignalConnectionPromiseFull(gobject,
        'signal', promiseHandler => promiseHandler.resolve('Hello!'),
        PromiseUtils.SignalConnectionPromiseFull.Flags.AFTER);

    let gotCb = false;
    let resolved = false;
    const id = gobject.connect('signal', () => {
        gotCb = true;
        gobject.disconnect(id);
        resolved = promise.resolved();
    });
    promise.object.emit('signal');
    JsUnit.assertTrue(gotCb);
    JsUnit.assertFalse(resolved);
    JsUnit.assertEquals('Hello!', await promise);
});

testCase('SignalConnectionPromiseFull with resolving handler and accumulator', async () => {
    const gobject = new SignalingGObject();
    const promise = new PromiseUtils.SignalConnectionPromiseFull(gobject,
        'accumulator_signal', (promiseHandler, arg) =>  {
            promiseHandler.resolve('Yay!');
            return `Accumulate me ${arg}!`;
        });

    JsUnit.assertEquals('Accumulate me 55!',
        promise.object.emit('accumulator_signal', 55));
    JsUnit.assertEquals('Yay!', await promise);
});

testCase('SignalConnectionPromiseFull with rejecting handler and accumulator', async () => {
    const gobject = new SignalingGObject();
    const promise = new PromiseUtils.SignalConnectionPromiseFull(gobject,
        'accumulator_signal', (promiseHandler, arg) => {
            promiseHandler.reject('Noooo!');
            return `Accumulate me ${arg}!`;
        });

    JsUnit.assertEquals(promise.object.emit('accumulator_signal', 0),
        'Accumulate me 0!');

    try {
        await promise;
        assertNotReached();
    } catch (e) {
        JsUnit.assertEquals('Noooo!', e);
    }
});

testCase('SignalConnectionPromiseFull with cancelled handler and accumulator', () => {
    const gobject = new SignalingGObject();
    const promise = new PromiseUtils.SignalConnectionPromiseFull(gobject,
        'accumulator_signal', () => JsUnit.assertNotReached());

    promise.cancel();
    JsUnit.assertNull(gobject.emit('accumulator_signal', -1));

    const e = assertRejected(promise);
    JsUnit.assertTrue(e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
    assertCancelledPromise(promise);
});

testCase('SignalConnectionPromiseFull for GObject with resolving handler', async () => {
    const gobject = new SignalingGObject();
    const promise = gobject.connect_with_promise('signal',
        promiseHandler => promiseHandler.resolve('Hello!'));

    promise.object.emit('signal');
    JsUnit.assertEquals('Hello!', await promise);
});

testCase('SignalConnectionPromiseFull for GObject with rejecting handler', async () => {
    const gobject = new SignalingGObject();
    const promise = gobject.connect_with_promise('signal',
        promiseHandler => promiseHandler.reject('Good bye!'));

    promise.object.emit('signal');
    try {
        await promise;
        assertNotReached();
    } catch (e) {
        JsUnit.assertEquals('Good bye!', e);
    }
});

testCase('SignalConnectionPromiseFull for GObject with no handler', () => {
    const gobject = new SignalingGObject();
    const promise = gobject.connect_with_promise('signal', () => {});

    try {
        GLib.test_expect_message('Gjs', GLib.LogLevelFlags.LEVEL_CRITICAL,
            '*Promise was not resolved or rejected*');
        promise.object.emit('signal');
        GLib.test_assert_expected_messages_internal('Gjs', 'promiseUtils.js', 0,
            'SignalConnectionPromiseFull for GObject with no handler');
    } catch (e) {}

    const e = assertRejected(promise);
    JsUnit.assertTrue(e.message.includes('Promise was not resolved or rejected'));
});

testCase('SignalConnectionPromiseFull for GObject with resolving handler and accumulator', async () => {
    const gobject = new SignalingGObject();
    const promise = gobject.connect_with_promise('accumulator_signal', (promiseHandler, arg) => {
        promiseHandler.resolve('Yay!');
        return `Accumulate me ${arg}!`;
    });

    JsUnit.assertEquals('Accumulate me 55!',
        promise.object.emit('accumulator_signal', 55));
    JsUnit.assertEquals('Yay!', await promise);
});

testCase('SignalConnectionPromiseFull for GObject with rejecting handler and accumulator', async () => {
    const gobject = new SignalingGObject();
    const promise = gobject.connect_with_promise('accumulator_signal', (promiseHandler, arg) => {
        promiseHandler.reject('Noooo!');
        return `Accumulate me ${arg}!`;
    });

    JsUnit.assertEquals(promise.object.emit('accumulator_signal', 0),
        'Accumulate me 0!');

    try {
        await promise;
        assertNotReached();
    } catch (e) {
        JsUnit.assertEquals('Noooo!', e);
    }
});

testCase('SignalConnectionPromiseFull for GObject with after resolving handler', async () => {
    const gobject = new SignalingGObject();
    const promise = gobject.connect_with_promise('signal',
        promiseHandler => promiseHandler.resolve('Hello!'),
        PromiseUtils.SignalConnectionPromiseFull.Flags.AFTER);

    let gotCb = false;
    let resolved = false;
    const id = gobject.connect('signal', () => {
        gotCb = true;
        gobject.disconnect(id);
        resolved = promise.resolved();
    });
    promise.object.emit('signal');
    JsUnit.assertTrue(gotCb);
    JsUnit.assertFalse(resolved);
    JsUnit.assertEquals('Hello!', await promise);
});

testCase('SignalConnectionPromiseFull for GObject with cancelled handler and accumulator', () => {
    const gobject = new SignalingGObject();
    const promise = gobject.connect_with_promise('accumulator_signal',
        () => JsUnit.assertNotReached());

    promise.cancel();
    JsUnit.assertNull(gobject.emit('accumulator_signal', -1));

    const e = assertRejected(promise);
    JsUnit.assertTrue(e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
    assertCancelledPromise(promise);
});

testCase('SignalConnectionPromiseFull for JSObject with resolving handler', async () => {
    const object = new SignalingJSObject();
    const promise = object.connect_with_promise('signal',
        promiseHandler => promiseHandler.resolve('Hello!'));

    promise.object.emit('signal');
    JsUnit.assertEquals('Hello!', await promise);
});

testCase('SignalConnectionPromiseFull for JSObject with rejecting handler', async () => {
    const object = new SignalingJSObject();
    const promise = object.connect_with_promise('signal',
        promiseHandler => promiseHandler.reject('Good bye!'));

    promise.object.emit('signal');
    try {
        await promise;
        assertNotReached();
    } catch (e) {
        JsUnit.assertEquals('Good bye!', e);
    }
});

testCase('SignalConnectionPromiseFull for JSObject with no handler', () => {
    const object = new SignalingJSObject();
    const promise = object.connect_with_promise('signal', () => {});

    try {
        GLib.test_expect_message('Gjs', GLib.LogLevelFlags.LEVEL_WARNING,
            '*Promise was not resolved or rejected*');
        promise.object.emit('signal');
        GLib.test_assert_expected_messages_internal('Gjs', 'promiseUtils.js', 0,
            'SignalConnectionPromiseFull for JSObject with no handler');
    } catch (e) {
        JsUnit.assertTrue(e.message.includes('Promise was not resolved or rejected'));
    }

    const e = assertRejected(promise);
    JsUnit.assertTrue(e.message.includes('Promise was not resolved or rejected'));
});

testCase('SignalConnectionPromiseFull for JSObject with after resolving handler', async () => {
    const object = new SignalingJSObject();
    JsUnit.assertRaises(() => object.connect_with_promise('signal',
        promiseHandler => promiseHandler.resolve('Hello!'),
        PromiseUtils.SignalConnectionPromiseFull.Flags.AFTER));
});


testCase('IdlePromise with invalid priority', () => {
    JsUnit.assertRaises(() => new PromiseUtils.IdlePromise('priority'));
});

testCase('IdlePromise with invalid cancellable', () => {
    JsUnit.assertRaises(() => new PromiseUtils.IdlePromise(GLib.PRIORITY_DEFAULT, {}));
});

testCase('IdlePromise with default priority', () => {
    const promise = new PromiseUtils.IdlePromise();

    JsUnit.assertNotNull(promise.gsource);
    JsUnit.assertEquals(GLib.PRIORITY_DEFAULT_IDLE, promise.gsource.get_priority());
    JsUnit.assertTrue(!!promise.gsource.get_name().match(
        /\[gnome-shell\] IdlePromise @unit\/promiseUtils\.js:\d+/));
    JsUnit.assertFalse(promise.gsource.is_destroyed());
    JsUnit.assertNotNull(promise.gsource.get_context());
    assertPendingPromise(promise);

    assertResolved(promise);
});

testCase('IdlePromise with explicit priority', () => {
    const promise = new PromiseUtils.IdlePromise(GLib.PRIORITY_DEFAULT);

    JsUnit.assertNotNull(promise.gsource);
    JsUnit.assertEquals(GLib.PRIORITY_DEFAULT, promise.gsource.get_priority());
    JsUnit.assertTrue(!!promise.gsource.get_name().match(
        /\[gnome-shell\] IdlePromise @unit\/promiseUtils\.js:\d+/));
    JsUnit.assertFalse(promise.gsource.is_destroyed());
    JsUnit.assertNotNull(promise.gsource.get_context());
    assertPendingPromise(promise);

    const gsource = promise.gsource;
    assertResolved(promise);
    JsUnit.assertTrue(gsource.is_destroyed());
});

testCase('IdlePromise is cancelled on cancel', async () => {
    const promise = new PromiseUtils.IdlePromise();
    assertPendingPromise(promise);
    JsUnit.assertNull(promise.cancellable);
    JsUnit.assertNotNull(promise.gsource);

    const gsource = promise.gsource;
    promise.cancel();
    JsUnit.assertNull(promise.gsource);

    await assertCancelledPromiseAsync(promise);
    JsUnit.assertTrue(gsource.is_destroyed());
});

testCase('IdlePromise with already cancelled GCancellable', async () => {
    const cancellable = new Gio.Cancellable();
    cancellable.cancel();
    const promise = new PromiseUtils.IdlePromise(GLib.PRIORITY_DEFAULT_IDLE, cancellable);
    JsUnit.assertEquals(cancellable, promise.cancellable);
    JsUnit.assertTrue(promise.gsource.is_destroyed());
    assertCancelledPromise(promise);

    await assertCancelledPromiseAsync(promise);
    JsUnit.assertEquals(cancellable, promise.cancellable);
});

testCase('IdlePromise is cancelled on GCancellable cancellation', async () => {
    const promise = new PromiseUtils.IdlePromise(GLib.PRIORITY_DEFAULT_IDLE,
        new Gio.Cancellable());
    JsUnit.assertNotNull(promise.cancellable);
    assertPendingPromise(promise);

    JsUnit.assertFalse(promise.gsource.is_destroyed());
    JsUnit.assertNotNull(promise.gsource.get_context());
    const gsource = promise.gsource;
    promise.cancellable.cancel();
    JsUnit.assertNull(promise.gsource);
    await assertCancelledPromiseAsync(promise);
    JsUnit.assertTrue(gsource.is_destroyed());
});

testCase('IdlePromise with GCancellable is cancelled with cancel', async () => {
    const promise = new PromiseUtils.IdlePromise(GLib.PRIORITY_DEFAULT_IDLE,
        new Gio.Cancellable());
    JsUnit.assertNotNull(promise.cancellable);
    assertPendingPromise(promise);

    const gsource = promise.gsource;
    promise.cancel();
    JsUnit.assertNull(promise.gsource);
    await assertCancelledPromiseAsync(promise);
    JsUnit.assertTrue(gsource.is_destroyed());
});

testCase('TimeoutPromise with invalid interval', () => {
    JsUnit.assertRaises(() => new PromiseUtils.TimeoutPromise('interval'));
});

testCase('TimeoutPromise with invalid priority', () => {
    JsUnit.assertRaises(() => new PromiseUtils.TimeoutPromise(10, 'priority'));
});

testCase('TimeoutPromise with invalid cancellable', () => {
    JsUnit.assertRaises(() => new PromiseUtils.TimeoutPromise(10, GLib.PRIORITY_DEFAULT, {}));
});

testCase('TimeoutPromise with default priority', () => {
    const promise = new PromiseUtils.TimeoutPromise(10);

    JsUnit.assertNotNull(promise.gsource);
    JsUnit.assertEquals(GLib.PRIORITY_DEFAULT, promise.gsource.get_priority());
    JsUnit.assertTrue(!!promise.gsource.get_name().match(
        /\[gnome-shell\] TimeoutPromise @unit\/promiseUtils\.js:\d+/));
    assertPendingPromise(promise);

    assertResolved(promise);
});

testCase('TimeoutPromise with explicit priority', () => {
    const promise = new PromiseUtils.TimeoutPromise(10, GLib.PRIORITY_DEFAULT_IDLE);

    JsUnit.assertNotNull(promise.gsource);
    JsUnit.assertEquals(GLib.PRIORITY_DEFAULT_IDLE, promise.gsource.get_priority());
    JsUnit.assertTrue(!!promise.gsource.get_name().match(
        /\[gnome-shell\] TimeoutPromise @unit\/promiseUtils\.js:\d+/));
    assertPendingPromise(promise);

    assertResolved(promise);
});

testCase('TimeoutPromise is cancelled on cancel', async () => {
    const promise = new PromiseUtils.TimeoutPromise(10);
    assertPendingPromise(promise);
    JsUnit.assertNull(promise.cancellable);
    JsUnit.assertNotNull(promise.gsource);

    const gsource = promise.gsource;
    promise.cancel();
    JsUnit.assertNull(promise.gsource);

    await assertCancelledPromiseAsync(promise);
    JsUnit.assertTrue(gsource.is_destroyed());
});

testCase('TimeoutPromise with already cancelled GCancellable', async () => {
    const cancellable = new Gio.Cancellable();
    cancellable.cancel();
    const promise = new PromiseUtils.TimeoutPromise(10, GLib.PRIORITY_DEFAULT, cancellable);
    JsUnit.assertEquals(cancellable, promise.cancellable);
    JsUnit.assertTrue(promise.gsource.is_destroyed());
    assertCancelledPromise(promise);

    await assertCancelledPromiseAsync(promise);
    JsUnit.assertEquals(cancellable, promise.cancellable);
});

testCase('TimeoutPromise is cancelled on GCancellable cancellation', async () => {
    const promise = new PromiseUtils.TimeoutPromise(10, GLib.PRIORITY_DEFAULT,
        new Gio.Cancellable());
    JsUnit.assertNotNull(promise.cancellable);
    assertPendingPromise(promise);

    promise.cancellable.cancel();
    JsUnit.assertNull(promise.gsource);
    await assertCancelledPromiseAsync(promise);
});

testCase('TimeoutPromise with GCancellable is cancelled with cancel', async () => {
    const promise = new PromiseUtils.TimeoutPromise(10, GLib.PRIORITY_DEFAULT,
        new Gio.Cancellable());
    JsUnit.assertNotNull(promise.cancellable);
    assertPendingPromise(promise);

    const gsource = promise.gsource;
    promise.cancel();
    JsUnit.assertNull(promise.gsource);
    await assertCancelledPromiseAsync(promise);
    JsUnit.assertTrue(gsource.is_destroyed());
});

testCase('TimeoutSecondsPromise with invalid interval', () => {
    JsUnit.assertRaises(() => new PromiseUtils.TimeoutSecondsPromise('interval'));
});

testCase('TimeoutSecondsPromise with invalid priority', () => {
    JsUnit.assertRaises(() => new PromiseUtils.TimeoutSecondsPromise(1, 'priority'));
});

testCase('TimeoutSecondsPromise with invalid cancellable', () => {
    JsUnit.assertRaises(() => new PromiseUtils.TimeoutSecondsPromise(1, GLib.PRIORITY_DEFAULT, {}));
});

testCase('TimeoutSecondsPromise with default priority', () => {
    const promise = new PromiseUtils.TimeoutSecondsPromise(1);

    JsUnit.assertNotNull(promise.gsource);
    JsUnit.assertEquals(GLib.PRIORITY_DEFAULT, promise.gsource.get_priority());
    JsUnit.assertTrue(!!promise.gsource.get_name().match(
        /\[gnome-shell\] TimeoutSecondsPromise @unit\/promiseUtils\.js:\d+/));
    assertPendingPromise(promise);

    assertResolved(promise);
});

testCase('TimeoutSecondsPromise with explicit priority', () => {
    const promise = new PromiseUtils.TimeoutSecondsPromise(1, GLib.PRIORITY_DEFAULT_IDLE);

    JsUnit.assertNotNull(promise.gsource);
    JsUnit.assertEquals(GLib.PRIORITY_DEFAULT_IDLE, promise.gsource.get_priority());
    JsUnit.assertTrue(!!promise.gsource.get_name().match(
        /\[gnome-shell\] TimeoutSecondsPromise @unit\/promiseUtils\.js:\d+/));
    assertPendingPromise(promise);

    assertResolved(promise);
});

testCase('TimeoutSecondsPromise is cancelled on cancel', async () => {
    const promise = new PromiseUtils.TimeoutSecondsPromise(1);
    assertPendingPromise(promise);
    JsUnit.assertNull(promise.cancellable);
    JsUnit.assertNotNull(promise.gsource);

    promise.cancel();
    JsUnit.assertNull(promise.gsource);

    await assertCancelledPromiseAsync(promise);
});

testCase('TimeoutSecondsPromise is cancelled on GCancellable cancellation', async () => {
    const promise = new PromiseUtils.TimeoutSecondsPromise(1, GLib.PRIORITY_DEFAULT,
        new Gio.Cancellable());
    JsUnit.assertNotNull(promise.cancellable);
    assertPendingPromise(promise);

    promise.cancellable.cancel();
    JsUnit.assertNull(promise.gsource);
    await assertCancelledPromiseAsync(promise);
});
