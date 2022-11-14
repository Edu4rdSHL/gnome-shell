// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

// Test cases for version comparison

const { GObject } = imports.gi;

const {testUtils: TestUtils} = imports.unit;
const {testCase} = TestUtils;

const JsUnit = imports.jsUnit;
const Signals = imports.misc.signals;

const Environment = imports.ui.environment;
const { TransientSignalHolder, registerDestroyableType } = imports.misc.signalTracker;

Environment.init();

const Destroyable = GObject.registerClass({
    Signals: { 'destroy': {} },
}, class Destroyable extends GObject.Object {});
registerDestroyableType(Destroyable);

const GObjectEmitter = GObject.registerClass({
    Signals: { 'signal': {} },
}, class GObjectEmitter extends Destroyable {});

const GObjectEmitterInt = GObject.registerClass({
    Signals: {'signal-int': {param_types: [GObject.TYPE_INT]}},
}, class GObjectEmitterInt extends GObjectEmitter {});


function hasSignalHandler(object, signalId) {
    if (!(object instanceof GObject.Object))
        throw new Error('Unsupported Object');

    return !!GObject.signal_handler_find(object, {signalId});
}

testCase('Regular JS Objects cannot be registered as Destroyable types', () => {
    JsUnit.assertRaises(() => registerDestroyableType({}.constructor.prototype));
    JsUnit.assertRaises(() => registerDestroyableType(class {}));
});

testCase('Signals.EventEmitter cannot be registered as Destroyable types', () => {
    class BadJSDestroyable extends Signals.EventEmitter {}
    JsUnit.assertRaises(() => registerDestroyableType(BadJSDestroyable));
});

testCase('TransientSignalHolder monitors destruction of owned object', () => {
    let ownedDestroyCalled = false;
    const owner = new Destroyable();
    const owned = new TransientSignalHolder(owner);

    owned.connectObject('destroy', () => (ownedDestroyCalled = true), owner);
    JsUnit.assertTrue(hasSignalHandler(owner, 'destroy'));
    JsUnit.assertTrue(hasSignalHandler(owned, 'destroy'));

    owned.emit('destroy');
    JsUnit.assertTrue(ownedDestroyCalled);

    JsUnit.assertFalse(hasSignalHandler(owner, 'destroy'));
    JsUnit.assertFalse(hasSignalHandler(owned, 'destroy'));
});

testCase('TransientSignalHolder monitors destruction of owned object without being destroyed', () => {
    let ownedDestroyCalled = false;
    let ownerDestroyCalled = false;
    const owner = new Destroyable();
    const owned = new TransientSignalHolder(owner);

    owned.connectObject('destroy', () => (ownedDestroyCalled = true), owner);
    JsUnit.assertTrue(hasSignalHandler(owner, 'destroy'));
    JsUnit.assertTrue(hasSignalHandler(owned, 'destroy'));

    owner.connectObject('destroy', () => (ownerDestroyCalled = true));

    owned.emit('destroy');
    JsUnit.assertTrue(ownedDestroyCalled);
    JsUnit.assertFalse(ownerDestroyCalled);

    JsUnit.assertTrue(hasSignalHandler(owner, 'destroy'));
    JsUnit.assertFalse(hasSignalHandler(owned, 'destroy'));
});

testCase('TransientSignalHolder is destroyed on owner destruction', () => {
    let ownedDestroyCalled = false;
    let ownerDestroyCalled = false;
    const owner = new Destroyable();
    const owned = new TransientSignalHolder(owner);

    owned.connectObject('destroy', () => (ownedDestroyCalled = true), owner);
    owner.connectObject('destroy', () => (ownerDestroyCalled = true));
    JsUnit.assertTrue(hasSignalHandler(owner, 'destroy'));
    JsUnit.assertTrue(hasSignalHandler(owned, 'destroy'));

    owner.emit('destroy');
    JsUnit.assertTrue(ownedDestroyCalled);
    JsUnit.assertTrue(ownerDestroyCalled);

    JsUnit.assertFalse(hasSignalHandler(owner, 'destroy'));
    JsUnit.assertFalse(hasSignalHandler(owned, 'destroy'));
});

testCase('TransientSignalHolder owner destruction keeps early monitored destructions', () => {
    let ownedDestroyCalled = false;
    let ownerDestroyCalled = false;
    const owner = new Destroyable();

    owner.connectObject('destroy', () => (ownerDestroyCalled = true));

    const owned = new TransientSignalHolder(owner);
    owned.connectObject('destroy', () => (ownedDestroyCalled = true), owner);
    JsUnit.assertTrue(hasSignalHandler(owner, 'destroy'));
    JsUnit.assertTrue(hasSignalHandler(owned, 'destroy'));

    owner.emit('destroy');
    JsUnit.assertTrue(ownedDestroyCalled);
    JsUnit.assertTrue(ownerDestroyCalled);

    JsUnit.assertFalse(hasSignalHandler(owner, 'destroy'));
    JsUnit.assertFalse(hasSignalHandler(owned, 'destroy'));
});

testCase('Signal emissions can be tracked', () => {
    const emitter1 = new Signals.EventEmitter();
    const emitter2 = new GObjectEmitter();

    const tracked1 = new Destroyable();
    const tracked2 = {};

    let count = 0;
    const handler = () => count++;

    emitter1.connectObject('signal', handler, tracked1);
    emitter2.connectObject('signal', handler, tracked1);

    emitter1.connectObject('signal', handler, tracked2);
    emitter2.connectObject('signal', handler, tracked2);

    JsUnit.assertEquals(count, 0);

    emitter1.emit('signal');
    emitter2.emit('signal');

    JsUnit.assertEquals(count, 4);

    tracked1.emit('destroy');

    emitter1.emit('signal');
    emitter2.emit('signal');

    JsUnit.assertEquals(count, 6);

    emitter1.disconnectObject(tracked2);
    emitter2.emit('destroy');

    emitter1.emit('signal');
    emitter2.emit('signal');

    JsUnit.assertEquals(count, 6);

    emitter1.connectObject(
        'signal', handler,
        'signal', handler, GObject.ConnectFlags.AFTER,
        tracked1);
    emitter2.connectObject(
        'signal', handler,
        'signal', handler, GObject.ConnectFlags.AFTER,
        tracked1);

    emitter1.emit('signal');
    emitter2.emit('signal');

    JsUnit.assertEquals(count, 10);

    tracked1.emit('destroy');
    emitter1.emit('signal');
    emitter2.emit('signal');

    JsUnit.assertEquals(count, 10);

    emitter1.connectObject('signal', handler, tracked1);
    emitter2.connectObject('signal', handler, tracked1);

    let transientHolder = new TransientSignalHolder(tracked1);

    emitter1.connectObject('signal', handler, transientHolder);
    emitter2.connectObject('signal', handler, transientHolder);

    emitter1.emit('signal');
    emitter2.emit('signal');

    JsUnit.assertEquals(count, 14);

    transientHolder.destroy();

    emitter1.emit('signal');
    emitter2.emit('signal');

    JsUnit.assertEquals(count, 16);

    transientHolder = new TransientSignalHolder(tracked1);

    emitter1.connectObject('signal', handler, transientHolder);
    emitter2.connectObject('signal', handler, transientHolder);

    emitter1.emit('signal');
    emitter2.emit('signal');

    JsUnit.assertEquals(count, 20);

    tracked1.emit('destroy');
    emitter1.emit('signal');
    emitter2.emit('signal');

    JsUnit.assertEquals(count, 20);
});

testCase('Signal support default flags', () => {
    const obj = new Signals.EventEmitter();
    obj.connectObject('signal', () => {}, GObject.ConnectFlags.DEFAULT ?? 0, {});
});

testCase('Fails with unknown flags', () => {
    const obj = new Signals.EventEmitter();
    TestUtils.assertRaisesError(() => obj.connectObject('signal', () => {}, 256, {}),
        'Invalid flag value 256');
});

testCase('Emitter is same of tracker', () => {
    const obj = new GObjectEmitter();
    let callbackCalled = false;

    obj.connectObject('signal', () => (callbackCalled = true), obj);
    JsUnit.assertTrue(hasSignalHandler(obj, 'signal'));
    JsUnit.assertTrue(hasSignalHandler(obj, 'destroy'));

    obj.emit('signal');
    JsUnit.assertTrue(callbackCalled);
    JsUnit.assertTrue(hasSignalHandler(obj, 'signal'));
    JsUnit.assertTrue(hasSignalHandler(obj, 'destroy'));

    obj.emit('destroy');
    JsUnit.assertFalse(hasSignalHandler(obj, 'signal'));
    JsUnit.assertFalse(hasSignalHandler(obj, 'destroy'));
});

testCase('Emitter is same of tracker after', () => {
    const obj = new GObjectEmitter();
    let callbackCalled = false;

    obj.connectObject('destroy', () => (callbackCalled = true),
        GObject.ConnectFlags.AFTER, obj);
    JsUnit.assertTrue(hasSignalHandler(obj, 'destroy'));

    obj.emit('destroy');
    JsUnit.assertTrue(callbackCalled);
    JsUnit.assertFalse(hasSignalHandler(obj, 'destroy'));
});

testCase('Emitter is disconnected on tracker destruction', () => {
    const obj = new GObjectEmitter();
    const tracker = new Destroyable();
    let callbackCalled = false;

    obj.connectObject('signal', () => (callbackCalled = true), tracker);
    JsUnit.assertTrue(hasSignalHandler(obj, 'signal'));
    JsUnit.assertTrue(hasSignalHandler(obj, 'destroy'));
    JsUnit.assertTrue(hasSignalHandler(tracker, 'destroy'));

    obj.emit('signal');
    JsUnit.assertTrue(callbackCalled);
    JsUnit.assertTrue(hasSignalHandler(obj, 'signal'));
    JsUnit.assertTrue(hasSignalHandler(obj, 'destroy'));
    JsUnit.assertTrue(hasSignalHandler(tracker, 'destroy'));

    tracker.emit('destroy');
    JsUnit.assertFalse(hasSignalHandler(obj, 'signal'));
    JsUnit.assertFalse(hasSignalHandler(obj, 'destroy'));
    JsUnit.assertFalse(hasSignalHandler(tracker, 'destroy'));
});

testCase('Emitter with no tracker, disconnects on destruction', () => {
    const obj = new GObjectEmitter();
    let callbackCalled = false;

    obj.connectObject('signal', () => (callbackCalled = true));
    JsUnit.assertTrue(hasSignalHandler(obj, 'signal'));
    JsUnit.assertTrue(hasSignalHandler(obj, 'destroy'));

    obj.emit('signal');
    JsUnit.assertTrue(callbackCalled);

    obj.emit('destroy');
    JsUnit.assertFalse(hasSignalHandler(obj, 'signal'));
    JsUnit.assertFalse(hasSignalHandler(obj, 'destroy'));
});

testCase('Emitter with empty tracker, disconnects on disconnectObject', () => {
    const obj = new GObjectEmitter();
    const tracker = {};

    let callbackCalled = false;
    obj.connectObject('signal', () => (callbackCalled = true), tracker);
    JsUnit.assertTrue(hasSignalHandler(obj, 'signal'));
    JsUnit.assertTrue(hasSignalHandler(obj, 'destroy'));

    obj.emit('signal');
    JsUnit.assertTrue(callbackCalled);

    obj.disconnectObject(tracker);
    JsUnit.assertFalse(hasSignalHandler(obj, 'signal'));
    JsUnit.assertFalse(hasSignalHandler(obj, 'destroy'));
});

testCase('Signal arguments are respected', () => {
    const emitter = new Signals.EventEmitter();
    const tracked = new Destroyable();
    let cbCalled = false;

    emitter.connectObject('signal', (...args) => {
        TestUtils.assertArrayEquals([emitter, 'add', 4, 'arguments', null], args);
        cbCalled = true;
    }, tracked);

    emitter.emit('signal', 'add', 4, 'arguments', null);
    tracked.emit('destroy');

    JsUnit.assertTrue(cbCalled);
    emitter.emit('signal');
});

testCase('Signal after connection is respected', () => {
    let callbackCalled = false;
    let callbackAfterCalled = false;
    const emitter = new GObjectEmitter();

    emitter.connectObject('signal', () => {
        JsUnit.assertTrue(callbackCalled);
        JsUnit.assertFalse(callbackAfterCalled);
        callbackAfterCalled = true;
    }, GObject.ConnectFlags.AFTER, {});

    emitter.connectObject('signal', () => {
        JsUnit.assertFalse(callbackAfterCalled);
        JsUnit.assertFalse(callbackCalled);
        callbackCalled = true;
    });

    emitter.emit('signal');
    JsUnit.assertTrue(callbackCalled);
    JsUnit.assertTrue(callbackAfterCalled);
});

testCase('Signal after connection is respected in batch connections', () => {
    let callbackCalled = false;
    let callbackAfterCalled = false;
    const emitter = new GObjectEmitter();

    emitter.connectObject(
        'signal', () => {
            JsUnit.assertTrue(callbackCalled);
            JsUnit.assertFalse(callbackAfterCalled);
            callbackAfterCalled = true;
        }, GObject.ConnectFlags.AFTER,
        'signal', () => {
            JsUnit.assertFalse(callbackAfterCalled);
            JsUnit.assertFalse(callbackCalled);
            callbackCalled = true;
        });

    emitter.emit('signal');
    JsUnit.assertTrue(callbackCalled);
    JsUnit.assertTrue(callbackAfterCalled);
});
